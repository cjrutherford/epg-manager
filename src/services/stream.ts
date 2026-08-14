import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DB_DIR } from '../db';
import { emitLog } from '../events';
import { findOrphanStreamDirs, selectStreamToEvict } from './stream-limits';

interface ActiveStream {
    process: ChildProcess;
    lastAccess: number;
    dir: string;
    segmentCount?: number;
}

const activeStreams = new Map<string, ActiveStream>();

/**
 * Ceiling on simultaneous transcodes. Each one is an ffmpeg process plus a
 * segment directory.
 *
 * Configurable at runtime, but `MAX_ACTIVE_STREAMS` in the environment still
 * wins: an operator capping a container's load should not have it silently
 * raised from the settings screen.
 */
const ENV_STREAM_LIMIT = process.env.MAX_ACTIVE_STREAMS
    ? Math.max(1, parseInt(process.env.MAX_ACTIVE_STREAMS, 10))
    : null;

let maxActiveStreams = ENV_STREAM_LIMIT ?? 6;

export function getMaxActiveStreams(): number {
    return maxActiveStreams;
}

/** Returns the limit actually in force, which may differ if the env pins it. */
export function setMaxActiveStreams(value: number): number {
    if (ENV_STREAM_LIMIT !== null) return ENV_STREAM_LIMIT;
    if (Number.isFinite(value) && value >= 1) maxActiveStreams = Math.floor(value);
    return maxActiveStreams;
}
/** A stream must be untouched this long before another request may evict it. */
const MIN_IDLE_BEFORE_EVICT_MS = 15000;
/** Idle streams are reaped entirely after this long. */
const STREAM_IDLE_TIMEOUT_MS = 300000;
/** Grace period before an unclaimed directory counts as abandoned. */
const ORPHAN_MIN_AGE_MS = 60000;

export class StreamCapacityError extends Error {
    readonly code = 'STREAM_LIMIT';

    constructor(limit: number) {
        super(`All ${limit} stream slots are in use. Stop another stream and try again.`);
        this.name = 'StreamCapacityError';
    }
}

export class StreamManager {
    static get streamsDir() {
        const dir = path.join(DB_DIR, 'streams');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    static keepAlive(id: string) {
        const stream = activeStreams.get(id);
        if (stream) {
            stream.lastAccess = Date.now();
        }
    }

    static async startStream(id: string, url: string): Promise<string> {
        // If already running and manifest exists, bump keep-alive and return
        if (activeStreams.has(id)) {
            this.keepAlive(id);
            const m3u8Path = path.join(this.streamsDir, id, 'index.m3u8');
            if (fs.existsSync(m3u8Path)) {
                return `/files/streams/${id}/index.m3u8`;
            }
            // Manifest not yet ready — fall through to wait below
        } else {
            // Make room before spawning another transcode. Only genuinely idle
            // streams are evicted — a full house of active viewers is refused
            // rather than interrupted.
            this.ensureCapacityFor(id);

            // Clean up any previous directory for this stream
            const strDir = path.join(this.streamsDir, id);
            if (fs.existsSync(strDir)) {
                fs.rmSync(strDir, { recursive: true, force: true });
            }
            fs.mkdirSync(strDir, { recursive: true });

            // FFmpeg args:
            //   -headers:           pass browser User-Agent & Accept headers to survive provider checks
            //   -reconnect flags:   reconnect on network drops AND EOF
            //   -fflags +genpts:    fix missing/bad PTS so HLS segments are well-formed
            //   -analyzeduration / -probesize: faster startup
            //   -c copy:            no transcode — low CPU
            //   -hls_time 4:        4-second segments
            //   -hls_list_size 10:  keep 10 segments in the playlist (40s sliding window)
            //   -hls_flags ...:     independent segments + append_list (keeps playlist stable)
            //                       + delete_segments so files leaving the window are removed;
            //                       without it a session grows on disk for as long as it runs
            //   -hls_delete_threshold 6: keep 6 expired segments past the window as slack for
            //                       clients lagging slightly behind live (~64s on disk total)
            //   -max_muxing_queue_size 2048: handles interleaved streams without dropping
            const ffmpeg = spawn('ffmpeg', [
                '-y',
                '-user_agent',          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                '-http_persistent',    '0',
                '-reconnect',          '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max','10',
                '-fflags',             '+genpts+discardcorrupt',
                '-analyzeduration',    '2000000',
                '-probesize',          '2000000',
                '-i', url,
                '-c', 'copy',
                '-f', 'hls',
                '-hls_time',           '4',
                '-hls_list_size',      '10',
                '-hls_flags',          'independent_segments+append_list+delete_segments',
                '-hls_delete_threshold', '6',
                '-hls_segment_type',   'mpegts',
                '-max_muxing_queue_size', '2048',
                path.join(strDir, 'index.m3u8')
            ], { stdio: 'pipe' });

            // Log stderr so we can debug failures
            ffmpeg.stderr?.on('data', (chunk: Buffer) => {
                const line = chunk.toString();
                // Filter out benign ffmpeg HTTP keep-alive retry notices
                if (/keepalive request failed|retrying with new connection/i.test(line)) {
                    return;
                }
                if (/error|failed|invalid/i.test(line)) {
                    emitLog(`[stream:${id}] ${line.trim()}`, 'warning');
                }
            });

            activeStreams.set(id, {
                process: ffmpeg,
                lastAccess: Date.now(),
                dir: strDir,
                segmentCount: 0,
            });

            ffmpeg.on('close', (code) => {
                const stream = activeStreams.get(id);
                if (stream && stream.process === ffmpeg) {
                    activeStreams.delete(id);
                    // Only remove dir if stream was actually abandoned (no access in last 20s)
                    if (Date.now() - stream.lastAccess > 20000) {
                        try { fs.rmSync(stream.dir, { recursive: true, force: true }); } catch (_) { }
                    }
                }
            });

            ffmpeg.on('error', (err) => {
                emitLog(`Stream ${id} ffmpeg error: ${err.message}`, 'error');
            });
        }

        // Wait until at least 1 .ts segment exists before handing off the URL.
        const strDir = path.join(this.streamsDir, id);
        const m3u8Path = path.join(strDir, 'index.m3u8');
        let attempts = 0;
        const maxAttempts = 60; // up to 30 seconds

        while (attempts < maxAttempts) {
            // Count .ts segment files written so far
            let segCount = 0;
            try {
                segCount = fs.readdirSync(strDir).filter(f => f.endsWith('.ts')).length;
            } catch (_) { }

            if (segCount >= 1 && fs.existsSync(m3u8Path)) {
                return `/files/streams/${id}/index.m3u8`;
            }

            // If ffmpeg has already exited, it failed
            const st = activeStreams.get(id);
            if (!st || st.process.killed || st.process.exitCode !== null) {
                activeStreams.delete(id);
                try { fs.rmSync(strDir, { recursive: true, force: true }); } catch (_) { }
                throw new Error('Stream failed to start — channel may be offline.');
            }

            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }

        this.stopStream(id);
        throw new Error('Timeout waiting for stream buffer — channel might be offline.');
    }

    static stopStream(id: string) {
        const stream = activeStreams.get(id);
        if (stream) {
            stream.process.kill('SIGKILL');
            activeStreams.delete(id);
            try { fs.rmSync(stream.dir, { recursive: true, force: true }); } catch (_) { }
        }
    }

    static stopAll() {
        for (const [id, stream] of activeStreams.entries()) {
            try {
                stream.process.kill('SIGKILL');
            } catch (_) {}
            activeStreams.delete(id);
            try { fs.rmSync(stream.dir, { recursive: true, force: true }); } catch (_) { }
        }
    }

    /**
     * Free a slot for an incoming stream, evicting the least-recently-watched
     * idle session. Throws when every slot is genuinely in use — refusing a new
     * stream is better than cutting off someone mid-programme.
     */
    private static ensureCapacityFor(incomingId: string) {
        if (activeStreams.size < maxActiveStreams) return;

        const candidates = Array.from(activeStreams.entries()).map(([id, stream]) => ({
            id,
            lastAccess: stream.lastAccess
        }));

        const evictId = selectStreamToEvict(candidates, {
            now: Date.now(),
            minIdleMs: MIN_IDLE_BEFORE_EVICT_MS,
            protectIds: [incomingId]
        });

        if (!evictId) {
            emitLog(`Stream request refused: all ${maxActiveStreams} slots are actively in use.`, 'warning');
            throw new StreamCapacityError(maxActiveStreams);
        }

        emitLog(`Evicting idle stream ${evictId} to free a slot (limit ${maxActiveStreams}).`, 'info');
        this.stopStream(evictId);
    }

    /**
     * Remove stream directories with no live process behind them. The boot
     * purge in db.ts handles a clean restart; this catches sessions orphaned
     * while the server keeps running.
     */
    static sweepOrphanDirs() {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(this.streamsDir, { withFileTypes: true });
        } catch (_) {
            return;
        }

        const dirs = entries
            .filter(entry => entry.isDirectory())
            .map(entry => {
                const dirPath = path.join(this.streamsDir, entry.name);
                let modifiedMs = 0;
                try { modifiedMs = fs.statSync(dirPath).mtimeMs; } catch (_) { return null; }
                return { name: entry.name, modifiedMs };
            })
            .filter((dir): dir is { name: string; modifiedMs: number } => dir !== null);

        const orphans = findOrphanStreamDirs(dirs, activeStreams.keys(), {
            now: Date.now(),
            minAgeMs: ORPHAN_MIN_AGE_MS
        });

        for (const name of orphans) {
            try {
                fs.rmSync(path.join(this.streamsDir, name), { recursive: true, force: true });
                console.log(`[StreamManager] Removed orphaned stream directory ${name}.`);
            } catch (err: any) {
                console.error(`[StreamManager] Failed to remove orphaned directory ${name}:`, err.message);
            }
        }
    }

    static cleanup() {
        const now = Date.now();
        for (const [id, stream] of activeStreams.entries()) {
            if (now - stream.lastAccess > STREAM_IDLE_TIMEOUT_MS) {
                console.log(`[StreamManager] Stream ${id} inactive for >5 mins; stopping ffmpeg process.`);
                this.stopStream(id);
            }
        }
        this.sweepOrphanDirs();
    }
}

// Register process shutdown signal traps to kill all active FFmpeg processes
process.on('SIGTERM', () => StreamManager.stopAll());
process.on('SIGINT', () => StreamManager.stopAll());
process.on('exit', () => StreamManager.stopAll());

// Check for abandoned streams every 10 seconds
setInterval(() => StreamManager.cleanup(), 10000);
