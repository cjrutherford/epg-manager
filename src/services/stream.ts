import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DB_DIR } from '../db';
import { emitLog } from '../events';

interface ActiveStream {
    process: ChildProcess;
    lastAccess: number;
    dir: string;
    segmentCount?: number;
}

const activeStreams = new Map<string, ActiveStream>();

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
            // Clean up any previous directory for this stream
            const strDir = path.join(this.streamsDir, id);
            if (fs.existsSync(strDir)) {
                fs.rmSync(strDir, { recursive: true, force: true });
            }
            fs.mkdirSync(strDir, { recursive: true });

            // FFmpeg args:
            //   -reconnect flags:   survive brief upstream hiccups
            //   -fflags +genpts:    fix missing/bad PTS so HLS segments are well-formed
            //   -analyzeduration / -probesize: faster startup
            //   -c copy:            no transcode — low CPU
            //   -hls_time 4:        4-second segments
            //   -hls_list_size 10:  keep 10 segments in the playlist (40s sliding window)
            //   -hls_flags ...:     independent segments + do NOT delete old segments
            //                       (append_list keeps growing so seek-back works; omit
            //                        delete_segments so hls.js always finds the segment it wants)
            //   -max_muxing_queue_size 2048: handles interleaved streams without dropping
            const ffmpeg = spawn('ffmpeg', [
                '-y',
                '-reconnect',          '1',
                '-reconnect_at_eof',   '0',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max','5',
                '-fflags',             '+genpts+discardcorrupt',
                '-analyzeduration',    '2000000',
                '-probesize',          '2000000',
                '-i', url,
                '-c', 'copy',
                '-f', 'hls',
                '-hls_time',           '4',
                '-hls_list_size',      '10',
                '-hls_flags',          'independent_segments+append_list',
                '-hls_segment_type',   'mpegts',
                '-max_muxing_queue_size', '2048',
                path.join(strDir, 'index.m3u8')
            ], { stdio: 'pipe' });

            // Log stderr so we can debug failures
            ffmpeg.stderr?.on('data', (chunk: Buffer) => {
                // Only emit actual errors, not progress lines
                const line = chunk.toString();
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
                    try { fs.rmSync(stream.dir, { recursive: true, force: true }); } catch (_) { }
                }
            });

            ffmpeg.on('error', (err) => {
                emitLog(`Stream ${id} ffmpeg error: ${err.message}`, 'error');
            });
        }

        // Wait until at least 3 .ts segments exist before handing off the URL.
        // This ensures the client always has ~12s of look-ahead buffer and never
        // immediately stalls at the live edge.
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

    static cleanup() {
        const now = Date.now();
        for (const [id, stream] of activeStreams.entries()) {
            // Stop stream if no access in last 30 seconds
            if (now - stream.lastAccess > 30000) {
                this.stopStream(id);
            }
        }
    }
}

// Check for abandoned streams every 10 seconds
setInterval(() => StreamManager.cleanup(), 10000);
