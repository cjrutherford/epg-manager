/**
 * IPTV DVR Recorder — Server-side recording manager
 * Uses ffmpeg to capture HLS streams to MP4 files.
 */

import { spawn, ChildProcess } from 'child_process';
import { db, getSetting } from './db';
import path from 'path';
import fs from 'fs';
import { selectSchedulableEpisodes } from './services/series-rules';
import {
    appendStderr,
    classifyFfmpegFailure,
    classifySchedule,
    describeExhausted,
    parseWindow,
    resolvePadding,
    retryDelayMs,
    shouldRetry,
    type RecordingPadding
} from './services/dvr-lifecycle';
import {
    DEFAULT_RETENTION,
    evaluateRetention,
    formatBytes,
    meetsFreeSpaceFloor,
    resolveRecordingPath,
    type RetentionCandidate,
    type RetentionMode,
    type RetentionPolicy
} from './services/recording-storage';

// Active recording processes
const activeProcesses = new Map<number, ChildProcess>();

/**
 * Finalisation work still running after a process exits — merging parts,
 * writing the completed row. A recording is not safe until these settle, so
 * shutdown waits on them rather than on the process map alone.
 */
const pendingFinalizations = new Set<Promise<void>>();

/** Set once shutdown begins, so a dying ffmpeg is not treated as a retryable failure. */
let shuttingDown = false;

export function beginRecorderShutdown(): void {
    shuttingDown = true;
}

function trackFinalization(task: Promise<void>): void {
    pendingFinalizations.add(task);
    task.catch(() => { /* errors are reported by the task itself */ })
        .finally(() => pendingFinalizations.delete(task));
}

// Recording output directory
function getRecordingsDir(): string {
    const dataDir = process.env.DB_DIR || './data';
    const dir = path.join(dataDir, 'recordings');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

const GIB = 1024 * 1024 * 1024;

/** Free bytes on the volume holding the recordings directory. */
export function getFreeSpaceBytes(): number {
    try {
        const stats = fs.statfsSync(getRecordingsDir());
        return stats.bavail * stats.bsize;
    } catch (_) {
        // Unknown free space must not block recording — fail open.
        return Number.POSITIVE_INFINITY;
    }
}

/** Total and used bytes for the volume holding the recordings directory. */
export function getVolumeUsage(): { totalBytes: number; freeBytes: number; usedBytes: number } {
    try {
        const stats = fs.statfsSync(getRecordingsDir());
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bavail * stats.bsize;
        return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
    } catch (_) {
        return { totalBytes: 0, freeBytes: 0, usedBytes: 0 };
    }
}

function parsePositiveNumber(raw: string | null, fallback: number): number {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Retention configuration, defaulting to 30-day age expiry. */
export async function getRetentionPolicy(): Promise<RetentionPolicy> {
    const modeRaw = (await getSetting('dvr_retention_mode')) as RetentionMode | null;
    const allowed: RetentionMode[] = ['off', 'age', 'size', 'low-space'];
    const mode = modeRaw && allowed.includes(modeRaw) ? modeRaw : DEFAULT_RETENTION.mode;

    return {
        mode,
        maxAgeDays: parsePositiveNumber(await getSetting('dvr_retention_days'), DEFAULT_RETENTION.maxAgeDays),
        budgetBytes: parsePositiveNumber(await getSetting('dvr_size_budget_gb'), DEFAULT_RETENTION.budgetBytes / GIB) * GIB,
        minFreeBytes: parsePositiveNumber(await getSetting('dvr_min_free_gb'), DEFAULT_RETENTION.minFreeBytes / GIB) * GIB
    };
}

/** Configured pre/post recording padding. */
export async function getRecordingPadding(): Promise<RecordingPadding> {
    return resolvePadding(
        await getSetting('dvr_padding_start_seconds'),
        await getSetting('dvr_padding_end_seconds')
    );
}

/** Resolve a recording filename to a safe absolute path, or null if it escapes the directory. */
export function safeRecordingPath(filename: string): string | null {
    return resolveRecordingPath(getRecordingsDir(), filename, { allowedExtensions: ['.mp4'] });
}

/**
 * Timestamp a recording is aged from: when the programme ended, falling back
 * to when it was scheduled.
 */
function completedAtMs(row: Record<string, unknown>): number {
    const endTime = row.end_time ? Date.parse(String(row.end_time)) : NaN;
    if (Number.isFinite(endTime)) return endTime;
    const createdAt = Number(row.created_at);
    return Number.isFinite(createdAt) && createdAt > 0 ? createdAt * 1000 : 0;
}

/**
 * Apply the retention policy. Only completed recordings with a file are ever
 * eligible; anything scheduled or in flight is left alone.
 */
export async function applyRetentionPolicy(): Promise<number> {
    try {
        const policy = await getRetentionPolicy();
        if (policy.mode === 'off') return 0;

        const result = await db.execute(
            'SELECT id, filename, status, end_time, created_at, file_size FROM scheduled_recordings'
        );

        const candidates: RetentionCandidate[] = result.rows.map(row => ({
            id: Number(row.id),
            filename: row.filename ? String(row.filename) : null,
            status: String(row.status || ''),
            completedAtMs: completedAtMs(row as Record<string, unknown>),
            sizeBytes: Number(row.file_size) || 0
        }));

        const decision = evaluateRetention(candidates, policy, {
            now: Date.now(),
            freeBytes: getFreeSpaceBytes()
        });

        if (decision.prune.length === 0) return 0;

        let removed = 0;
        let reclaimed = 0;
        for (const candidate of decision.prune) {
            const filePath = candidate.filename ? safeRecordingPath(candidate.filename) : null;
            if (filePath) {
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (e: any) {
                    console.error(`[RETENTION] Failed to delete ${candidate.filename}:`, e.message);
                    continue;
                }
            }
            await db.execute({
                sql: 'DELETE FROM scheduled_recordings WHERE id = ?',
                args: [candidate.id]
            });
            reclaimed += candidate.sizeBytes;
            removed++;
        }

        if (removed > 0) {
            console.log(
                `[RETENTION] Removed ${removed} recording(s) (${decision.reason}), reclaiming ${formatBytes(reclaimed)}.`
            );
        }
        return removed;
    } catch (e: any) {
        console.error('[RETENTION] Retention sweep failed:', e.message);
        return 0;
    }
}

/**
 * Helper to delete all segment parts matching a base filename
 */
function cleanUpAllPartsForFilename(baseFilename: string) {
    try {
        const dir = getRecordingsDir();
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (file === baseFilename || file.startsWith(`${baseFilename}.part`)) {
                try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
            }
        }
    } catch (_) {}
}

/**
 * Helper to delete specific list of part file paths
 */
function cleanUpParts(partPaths: string[]) {
    for (const p of partPaths) {
        try {
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (_) {}
    }
}

/**
 * Finalize single file (either rename from part or verify size)
 */
async function finalizeSingleFile(recordingId: number, singlePath?: string): Promise<void> {
    const result = await db.execute({
        sql: 'SELECT * FROM scheduled_recordings WHERE id = ?',
        args: [recordingId],
    });
    if (result.rows.length === 0) return;
    const rec = result.rows[0];
    const filename = rec.filename as string;
    const outputPath = path.join(getRecordingsDir(), filename);
    const actualPath = singlePath || outputPath;

    try {
        if (actualPath !== outputPath && fs.existsSync(actualPath)) {
            fs.renameSync(actualPath, outputPath);
        }

        if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            await db.execute({
                sql: 'UPDATE scheduled_recordings SET status = ?, file_size = ? WHERE id = ?',
                args: ['completed', stats.size, recordingId],
            });
            console.log(`[RECORDER] Recording ${recordingId} finalized (single file): ${filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
        } else {
            await db.execute({
                sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
                args: ['failed', 'No video was captured — the stream produced no data before the recording ended', recordingId],
            });
        }
    } catch (e: any) {
        await db.execute({
            sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
            args: ['failed', `The recording could not be saved to disk: ${e.message}`, recordingId],
        });
    }
}

/**
 * Merge multiple recording part segments using FFmpeg's concat demuxer
 */
async function mergeRecordingParts(recordingId: number, partPaths: string[]): Promise<void> {
    const result = await db.execute({
        sql: 'SELECT * FROM scheduled_recordings WHERE id = ?',
        args: [recordingId],
    });
    if (result.rows.length === 0) return;
    const rec = result.rows[0];
    const filename = rec.filename as string;
    const outputPath = path.join(getRecordingsDir(), filename);

    // Filter to only existing parts with non-zero size
    const existingParts = partPaths.filter(p => {
        try {
            return fs.existsSync(p) && fs.statSync(p).size > 0;
        } catch (_) {
            return false;
        }
    });

    if (existingParts.length === 0) {
        await db.execute({
            sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
            args: ['failed', 'No video was captured — every attempt produced an empty file', recordingId],
        });
        return;
    }

    if (existingParts.length === 1) {
        await finalizeSingleFile(recordingId, existingParts[0]);
        return;
    }

    console.log(`[RECORDER] Concatenating ${existingParts.length} parts for recording ${recordingId}...`);

    // Create concat text file for FFmpeg demuxer
    const txtPath = path.join(getRecordingsDir(), `concat_${recordingId}.txt`);
    const txtContent = existingParts.map(p => `file '${path.resolve(p)}'`).join('\n');
    fs.writeFileSync(txtPath, txtContent);

    // Run ffmpeg concat
    const concatFfmpeg = spawn('ffmpeg', [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', txtPath,
        '-c', 'copy',
        outputPath
    ]);

    // Resolve only once the concat has finished — callers (and shutdown) need
    // to know the output file is actually written, not just that ffmpeg started.
    await new Promise<void>((resolve) => {
    concatFfmpeg.on('close', async (code) => {
        try { fs.unlinkSync(txtPath); } catch (_) {}

        if (code === 0) {
            // Delete temporary parts
            for (const p of existingParts) {
                try { fs.unlinkSync(p); } catch (_) {}
            }

            try {
                const stats = fs.statSync(outputPath);
                await db.execute({
                    sql: 'UPDATE scheduled_recordings SET status = ?, file_size = ? WHERE id = ?',
                    args: ['completed', stats.size, recordingId],
                });
                console.log(`[RECORDER] Recording ${recordingId} concatenated and completed: ${filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
            } catch (e: any) {
                await db.execute({
                    sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
                    args: ['failed', `The joined recording could not be saved: ${e.message}`, recordingId],
                });
            }
        } else {
            // Failed to concat, keep parts but mark as failed
            // The parts are deliberately left on disk — they are the only
            // copy of what was captured, and joining can be retried.
            await db.execute({
                sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
                args: [
                    'failed',
                    `The ${existingParts.length} captured segments could not be joined into one file (ffmpeg exited ${code}). The segments have been kept on disk.`,
                    recordingId
                ],
            });
            console.error(`[RECORDER] Concatenation failed for recording ${recordingId}`);
        }
        resolve();
    });
    concatFfmpeg.on('error', (err) => {
        console.error(`[RECORDER] Concat process error for ${recordingId}:`, err.message);
        resolve();
    });
    });
}

/**
 * Spawns and manages a recording session segment.
 */
async function runRecordingSession(
    recordingId: number,
    attempt: number = 1,
    partPaths: string[] = []
): Promise<void> {
    const result = await db.execute({
        sql: 'SELECT * FROM scheduled_recordings WHERE id = ?',
        args: [recordingId],
    });

    if (result.rows.length === 0) return;
    const rec = result.rows[0];

    // If status has changed from recording, stop immediately
    if (rec.status !== 'recording') {
        cleanUpParts(partPaths);
        return;
    }

    const channelRes = await db.execute({
        sql: 'SELECT url, enabled FROM channels WHERE id = ?',
        args: [rec.channel_id as string],
    });
    if (channelRes.rows.length > 0 && channelRes.rows[0].enabled === 0) {
        await db.execute({
            sql: "UPDATE scheduled_recordings SET status = 'failed', error_message = 'The channel was disabled before this recording could start' WHERE id = ?",
            args: [recordingId],
        });
        cleanUpParts(partPaths);
        return;
    }

    const streamUrl = (channelRes.rows.length > 0 && channelRes.rows[0].url) ? (channelRes.rows[0].url as string) : (rec.stream_url as string);

    // The same window arithmetic the scheduler uses, so padding is honoured by
    // the process that actually records rather than only by the one that starts it.
    const padding = await getRecordingPadding();
    const verdict = classifySchedule(
        parseWindow(rec.start_time as string, rec.end_time as string),
        Date.now(),
        padding
    );

    if (verdict.action !== 'start') {
        // The window closed. Anything already captured is worth keeping; only a
        // session that never wrote a byte is a miss.
        if (partPaths.length > 0) {
            await mergeRecordingParts(recordingId, partPaths);
        } else {
            const reason = verdict.action === 'missed'
                ? verdict.reason
                : 'Missed — the recording window closed before capture began';
            await db.execute({
                sql: "UPDATE scheduled_recordings SET status = 'missed', error_message = ? WHERE id = ?",
                args: [reason, recordingId],
            });
        }
        return;
    }

    const durationSec = verdict.durationSeconds;

    // Refuse to start writing onto a volume that is already out of room —
    // ffmpeg would otherwise fail partway and leave an unplayable fragment.
    const policy = await getRetentionPolicy();
    const freeBytes = getFreeSpaceBytes();
    if (!meetsFreeSpaceFloor(freeBytes, policy.minFreeBytes)) {
        const message = `Not enough free space: ${formatBytes(freeBytes)} available, ${formatBytes(policy.minFreeBytes)} required`;
        console.warn(`[RECORDER] Recording ${recordingId} blocked — ${message}`);
        await db.execute({
            sql: "UPDATE scheduled_recordings SET status = 'failed', error_message = ? WHERE id = ?",
            args: [message, recordingId],
        });
        cleanUpParts(partPaths);
        return;
    }

    // Set filename if not yet defined
    const sanitize = (s: string) => (s || 'recording').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const baseFilename = rec.filename as string || `${sanitize(rec.program_title as string)}_${Date.now()}.mp4`;

    if (!rec.filename) {
        await db.execute({
            sql: 'UPDATE scheduled_recordings SET filename = ? WHERE id = ?',
            args: [baseFilename, recordingId],
        });
    }

    const partFilename = `${baseFilename}.part${attempt}`;
    const partPath = path.join(getRecordingsDir(), partFilename);
    partPaths.push(partPath);

    console.log(`[RECORDER] Starting recording ${recordingId} attempt ${attempt} ("${rec.program_title}", remaining ${durationSec}s)`);

    // Spawn ffmpeg with native reconnect switches for HLS/HTTP robustness
    const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-http_persistent', '0',
        '-reconnect', '1',
        '-reconnect_at_eof', '0',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '10',
        '-i', streamUrl,
        '-t', String(durationSec),
        '-c', 'copy',
        '-movflags', '+faststart',
        '-f', 'mp4',
        partPath,
    ], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcesses.set(recordingId, ffmpeg);

    // ffmpeg reports the actual cause of a failure here and nowhere else, so
    // the tail is kept to explain the failure rather than discarded.
    let stderrTail = '';
    ffmpeg.stderr?.on('data', (data: Buffer) => {
        stderrTail = appendStderr(stderrTail, data.toString());
    });

    ffmpeg.on('close', (code: number | null) => {
        activeProcesses.delete(recordingId);

        // Tracked so shutdown can wait for the file to be finalised, not just
        // for the process to be gone.
        trackFinalization((async () => {
            const currentRec = await db.execute({
                sql: 'SELECT status FROM scheduled_recordings WHERE id = ?',
                args: [recordingId],
            });
            if (currentRec.rows.length === 0) return;
            const currentStatus = currentRec.rows[0].status;

            // If recording was stopped/cancelled while this process was running
            if (currentStatus !== 'recording') {
                return;
            }

            if (code === 0 || code === 255) {
                // Natural ending or clean SIGINT manual stop
                await mergeRecordingParts(recordingId, partPaths);
                return;
            }

            const failure = classifyFfmpegFailure(code, stderrTail);
            console.warn(`[RECORDER] Recording ${recordingId} exited with code ${code}: ${failure.reason}`);

            // During shutdown a dying ffmpeg is expected — salvage what was
            // captured instead of scheduling a retry into a closing process.
            if (shuttingDown) {
                console.log(`[RECORDER] Shutdown in progress; finalising recording ${recordingId} as captured.`);
                await mergeRecordingParts(recordingId, partPaths);
                return;
            }

            // A 404 or a full disk will fail identically five times over; only
            // retry what could plausibly succeed on a second attempt.
            if (shouldRetry(failure, attempt)) {
                const delay = retryDelayMs(attempt);
                console.log(`[RECORDER] Retrying recording ${recordingId} in ${delay / 1000}s (attempt ${attempt + 1}): ${failure.reason}`);
                await db.execute({
                    sql: 'UPDATE scheduled_recordings SET error_message = ? WHERE id = ?',
                    args: [`${failure.reason} — retrying (attempt ${attempt + 1})`, recordingId],
                });
                setTimeout(() => {
                    if (shuttingDown) return;
                    runRecordingSession(recordingId, attempt + 1, partPaths).catch(err => {
                        console.error(`[RECORDER] Failed to restart recording session:`, err);
                    });
                }, delay);
                return;
            }

            const summary = failure.retryable ? describeExhausted(failure, attempt) : failure.reason;
            console.error(`[RECORDER] Recording ${recordingId} not retried: ${summary}`);

            // Whatever was captured before the failure is still worth keeping.
            const captured = partPaths.filter(p => {
                try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch (_) { return false; }
            });

            if (captured.length > 0) {
                if (captured.length > 1) {
                    await mergeRecordingParts(recordingId, captured);
                } else {
                    await finalizeSingleFile(recordingId, captured[0]);
                }
                // Finalisation marks it completed; the reason explains why it is short.
                await db.execute({
                    sql: 'UPDATE scheduled_recordings SET error_message = ? WHERE id = ?',
                    args: [`Recording ended early: ${summary}`, recordingId],
                });
            } else {
                await db.execute({
                    sql: "UPDATE scheduled_recordings SET status = 'failed', error_message = ? WHERE id = ?",
                    args: [summary, recordingId],
                });
            }
        })());
    });

    ffmpeg.on('error', (err: Error) => {
        activeProcesses.delete(recordingId);
        console.error(`[RECORDER] Recording ${recordingId} process error:`, err.message);
    });
}

/**
 * Start recording a stream to a file
 */
export async function startRecording(recordingId: number): Promise<void> {
    await db.execute({
        sql: "UPDATE scheduled_recordings SET status = 'recording' WHERE id = ?",
        args: [recordingId],
    });

    runRecordingSession(recordingId, 1, []).catch(err => {
        console.error(`[RECORDER] Failed starting session loop for ${recordingId}:`, err);
    });
}

/**
 * Stop an active recording
 */
export async function stopRecording(recordingId: number): Promise<void> {
    const proc = activeProcesses.get(recordingId);
    if (proc) {
        // Send SIGINT for graceful shutdown (ffmpeg finalizes the file)
        proc.kill('SIGINT');
    }
}

/**
 * Stop every active recording and wait for its file to be finalised.
 *
 * ffmpeg finalises an MP4 on SIGINT, so a graceful stop yields a playable file
 * rather than a fragment the next boot has to salvage. Returns once everything
 * has settled, or when the timeout expires — whichever comes first.
 */
export async function drainRecordings(timeoutMs = 20000): Promise<{ drained: number; timedOut: boolean }> {
    beginRecorderShutdown();

    const ids = Array.from(activeProcesses.keys());
    if (ids.length === 0 && pendingFinalizations.size === 0) {
        return { drained: 0, timedOut: false };
    }

    console.log(`[RECORDER] Draining ${ids.length} active recording(s)...`);
    for (const id of ids) {
        try {
            activeProcesses.get(id)?.kill('SIGINT');
        } catch (e: any) {
            console.error(`[RECORDER] Failed to signal recording ${id}:`, e.message);
        }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (activeProcesses.size === 0 && pendingFinalizations.size === 0) {
            console.log(`[RECORDER] Drained ${ids.length} recording(s) cleanly.`);
            return { drained: ids.length, timedOut: false };
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.warn(
        `[RECORDER] Drain timed out after ${timeoutMs}ms; ${activeProcesses.size} process(es) and ` +
        `${pendingFinalizations.size} finalisation(s) still pending. Partial files will be recovered on next boot.`
    );
    return { drained: ids.length, timedOut: true };
}

/**
 * Cancel a scheduled recording
 */
export async function cancelRecording(recordingId: number): Promise<void> {
    // If it's actively recording, stop it first
    const proc = activeProcesses.get(recordingId);
    if (proc) {
        proc.kill('SIGINT');
        activeProcesses.delete(recordingId);
    }

    // Get recording info for file cleanup
    const result = await db.execute({
        sql: 'SELECT * FROM scheduled_recordings WHERE id = ?',
        args: [recordingId],
    });

    if (result.rows.length > 0) {
        const rec = result.rows[0];
        if (rec.filename) {
            cleanUpAllPartsForFilename(rec.filename as string);
        }
    }

    await db.execute({
        sql: 'DELETE FROM scheduled_recordings WHERE id = ?',
        args: [recordingId],
    });
}

/**
 * Check for scheduled recordings that should start now
 */
export async function checkScheduledRecordings(): Promise<void> {
    const now = Date.now();
    const padding = await getRecordingPadding();

    // Every scheduled row is examined, not just those whose start has passed:
    // pre-padding can make a row due before its advertised start.
    const result = await db.execute(
        `SELECT id, start_time, end_time, program_title FROM scheduled_recordings WHERE status = 'scheduled'`
    );

    for (const row of result.rows) {
        const id = row.id as number;
        const verdict = classifySchedule(
            parseWindow(row.start_time as string, row.end_time as string),
            now,
            padding
        );

        if (verdict.action === 'wait') continue;

        if (verdict.action === 'missed') {
            // The window closed without us. Saying so is the whole point:
            // starting ffmpeg against a window that has already passed used to
            // produce "failed: Output file not found".
            console.warn(`[RECORDER] Recording ${id} ("${row.program_title}") missed — ${verdict.reason}`);
            await db.execute({
                sql: "UPDATE scheduled_recordings SET status = 'missed', error_message = ? WHERE id = ?",
                args: [verdict.reason, id],
            });
            continue;
        }

        try {
            if (verdict.lateBySeconds > 0) {
                console.warn(`[RECORDER] Starting recording ${id} ${Math.round(verdict.lateBySeconds / 60)} minute(s) late; capturing the remainder.`);
            }
            await startRecording(id);
        } catch (e: any) {
            console.error(`[RECORDER] Failed to start recording ${id}:`, e.message);
        }
    }
}

/**
 * Cleanup stale recordings (stuck in "recording" state without a process)
 */
export async function cleanupStaleRecordings(): Promise<void> {
    const result = await db.execute(
        `SELECT id, filename, program_title FROM scheduled_recordings WHERE status = 'recording'`
    );

    for (const row of result.rows) {
        const id = row.id as number;
        if (!activeProcesses.has(id)) {
            console.warn(`[RECORDER] Recovering stale recording ${id} ("${row.program_title}")...`);
            const baseFilename = row.filename as string;
            if (baseFilename) {
                // Find existing parts
                try {
                    const dir = getRecordingsDir();
                    const files = fs.readdirSync(dir);
                    const parts = files
                        .filter(f => f.startsWith(`${baseFilename}.part`) || f === baseFilename)
                        .map(f => path.join(dir, f));

                    if (parts.length > 0) {
                        if (parts.length === 1) {
                            await finalizeSingleFile(id, parts[0]);
                        } else {
                            await mergeRecordingParts(id, parts);
                        }
                        await db.execute({
                            sql: "UPDATE scheduled_recordings SET error_message = 'The server restarted mid-recording; what had been captured was recovered' WHERE id = ?",
                            args: [id],
                        });
                        continue;
                    }
                } catch (e: any) {
                    console.error(`[RECORDER] Error recovering parts for ${id}:`, e.message);
                }
            }

            await db.execute({
                sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
                args: ['failed', 'The server stopped while this was recording and nothing had been written to disk yet', id],
            });
        }
    }
}

/**
 * Auto-schedule upcoming episodes matching saved series rules
 */
export async function autoScheduleSeriesRules(): Promise<number> {
    try {
        const rulesRes = await db.execute('SELECT * FROM dvr_series_rules');
        if (rulesRes.rows.length === 0) return 0;

        const now = Date.now();
        let scheduledCount = 0;

        for (const rule of rulesRes.rows) {
            const channelId = String(rule.channel_id);
            const seriesTitle = String(rule.series_title || '').trim();
            if (!seriesTitle) continue;

            // COALESCE the override: a channel mapped by hand carries its guide
            // under the override id, so joining on matched_epg_id alone meant
            // series rules never fired for manually mapped channels.
            const progsRes = await db.execute({
                sql: `SELECT ep.title, ep.start, ep.stop, ep.sub_title, ep.episode_num,
                             ep.desc, ep.rating, ep.category, ep.icon,
                             c.name as channel_name, c.url as stream_url, c.tvg_logo as channel_logo
                      FROM channels c
                      LEFT JOIN manual_overrides mo ON mo.channel_id = c.id
                      JOIN epg_programs ep
                        ON ep.channel_id = COALESCE(mo.epg_id, c.matched_epg_id, c.id)
                      WHERE c.id = ? AND c.enabled = 1
                        AND LOWER(TRIM(ep.title)) = LOWER(TRIM(?))`,
                args: [channelId, seriesTitle]
            });

            if (progsRes.rows.length === 0) continue;

            const existingRes = await db.execute({
                sql: `SELECT program_title, start_time FROM scheduled_recordings WHERE channel_id = ?`,
                args: [channelId]
            });

            const chosen = selectSchedulableEpisodes(
                progsRes.rows.map(row => ({
                    title: String(row.title),
                    start: String(row.start),
                    stop: String(row.stop),
                    subTitle: row.sub_title ? String(row.sub_title) : null,
                    episodeNum: row.episode_num ? String(row.episode_num) : null,
                    description: row.desc ? String(row.desc) : null,
                    rating: row.rating ? String(row.rating) : null,
                    category: row.category ? String(row.category) : null,
                    icon: row.icon ? String(row.icon) : null
                })),
                existingRes.rows.map(row => ({
                    programTitle: String(row.program_title || ''),
                    startTimeIso: String(row.start_time || '')
                })),
                now
            );

            const first = progsRes.rows[0];
            for (const episode of chosen) {
                await db.execute({
                    sql: `INSERT INTO scheduled_recordings (
                            channel_id, channel_name, program_title, start_time, end_time, stream_url,
                            thumbnail, sub_title, episode_num, description, rating, category, status
                          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
                    args: [
                        channelId,
                        first.channel_name || null,
                        episode.title,
                        episode.startTimeIso,
                        episode.endTimeIso,
                        first.stream_url || '',
                        episode.icon || first.channel_logo || null,
                        episode.subTitle || null,
                        episode.episodeNum || null,
                        episode.description || null,
                        episode.rating || null,
                        episode.category || null
                    ]
                });
                scheduledCount++;
            }
        }

        if (scheduledCount > 0) {
            console.log(`[RECORDER] Series pass scheduled ${scheduledCount} new episode(s).`);
            checkScheduledRecordings();
        }
        return scheduledCount;
    } catch (e: any) {
        console.error('[RECORDER] Failed to process series rules:', e.message);
        return 0;
    }
}

/**
 * Get the path to a recording file for download
 */
export function getRecordingFilePath(filename: string): string {
    return path.join(getRecordingsDir(), filename);
}

/**
 * Start the recording scheduler (poll every 30 seconds)
 */
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let retentionInterval: ReturnType<typeof setInterval> | null = null;
let seriesPassInterval: ReturnType<typeof setInterval> | null = null;

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const SERIES_PASS_INTERVAL_MS = 60 * 60 * 1000; // hourly

export function startRecordingScheduler(): void {
    if (schedulerInterval) return;

    // Initial cleanup of stale recordings
    cleanupStaleRecordings();

    // Check for scheduled recordings every 30 seconds
    schedulerInterval = setInterval(() => {
        checkScheduledRecordings();
    }, 30000);

    // Also check immediately
    checkScheduledRecordings();

    // Retention runs on its own slower cadence, plus once at startup
    retentionInterval = setInterval(() => {
        applyRetentionPolicy().catch(err => console.error('[RETENTION] Sweep failed:', err));
    }, RETENTION_SWEEP_INTERVAL_MS);
    applyRetentionPolicy().catch(err => console.error('[RETENTION] Startup sweep failed:', err));

    // Series rules are evaluated against whatever guide data exists now, and
    // again as new data arrives. Nothing called this before, which is why the
    // feature never did anything (D4).
    seriesPassInterval = setInterval(() => {
        autoScheduleSeriesRules().catch(err => console.error('[RECORDER] Series pass failed:', err));
    }, SERIES_PASS_INTERVAL_MS);
    autoScheduleSeriesRules().catch(err => console.error('[RECORDER] Startup series pass failed:', err));

    console.log('[RECORDER] Recording scheduler started (30s interval, hourly retention and series pass)');
}

export function stopRecordingScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
    if (retentionInterval) {
        clearInterval(retentionInterval);
        retentionInterval = null;
    }
    if (seriesPassInterval) {
        clearInterval(seriesPassInterval);
        seriesPassInterval = null;
    }
}
