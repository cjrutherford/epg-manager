/**
 * IPTV DVR Recorder — Server-side recording manager
 * Uses ffmpeg to capture HLS streams to MP4 files.
 */

import { spawn, ChildProcess } from 'child_process';
import { db } from './db';
import path from 'path';
import fs from 'fs';

// Active recording processes
const activeProcesses = new Map<number, ChildProcess>();

// Recording output directory
function getRecordingsDir(): string {
    const dataDir = process.env.DB_DIR || './data';
    const dir = path.join(dataDir, 'recordings');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
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
                args: ['failed', 'Output file not found', recordingId],
            });
        }
    } catch (e: any) {
        await db.execute({
            sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
            args: ['failed', `Finalization error: ${e.message}`, recordingId],
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
            args: ['failed', 'No valid parts recorded', recordingId],
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
                    args: ['failed', `Concat finalization error: ${e.message}`, recordingId],
                });
            }
        } else {
            // Failed to concat, keep parts but mark as failed
            await db.execute({
                sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
                args: ['failed', `Concatenation failed with code ${code}`, recordingId],
            });
            console.error(`[RECORDER] Concatenation failed for recording ${recordingId}`);
        }
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

    const streamUrl = rec.stream_url as string;
    const endTime = new Date(rec.end_time as string);
    const now = new Date();

    const durationSec = Math.floor((endTime.getTime() - now.getTime()) / 1000);
    if (durationSec < 10) {
        // Schedule ended or too close to end
        if (partPaths.length > 0) {
            await mergeRecordingParts(recordingId, partPaths);
        } else {
            await finalizeSingleFile(recordingId);
        }
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

    ffmpeg.stderr?.on('data', (data: Buffer) => {
        // Optional stderr parser
    });

    ffmpeg.on('close', async (code: number | null) => {
        activeProcesses.delete(recordingId);

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
        } else {
            console.warn(`[RECORDER] Recording ${recordingId} process exited with error code ${code}`);

            // Retry logic
            if (attempt < 5) {
                console.log(`[RECORDER] Retrying recording ${recordingId} in 5 seconds (attempt ${attempt + 1})...`);
                setTimeout(() => {
                    runRecordingSession(recordingId, attempt + 1, partPaths).catch(err => {
                        console.error(`[RECORDER] Failed to restart recording session:`, err);
                    });
                }, 5000);
            } else {
                console.error(`[RECORDER] Recording ${recordingId} failed after max retries`);
                if (partPaths.length > 1) {
                    await mergeRecordingParts(recordingId, partPaths);
                } else {
                    await finalizeSingleFile(recordingId, partPath);
                }
            }
        }
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
    const now = new Date().toISOString();

    const result = await db.execute({
        sql: `SELECT id FROM scheduled_recordings
              WHERE status = 'scheduled' AND start_time <= ?`,
        args: [now],
    });

    for (const row of result.rows) {
        try {
            await startRecording(row.id as number);
        } catch (e: any) {
            console.error(`[RECORDER] Failed to start recording ${row.id}:`, e.message);
        }
    }
}

/**
 * Cleanup stale recordings (stuck in "recording" state without a process)
 */
export async function cleanupStaleRecordings(): Promise<void> {
    const result = await db.execute(
        `SELECT id FROM scheduled_recordings WHERE status = 'recording'`
    );

    for (const row of result.rows) {
        const id = row.id as number;
        if (!activeProcesses.has(id)) {
            await db.execute({
                sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
                args: ['failed', 'Process lost (server restart?)', id],
            });
            console.warn(`[RECORDER] Cleaned up stale recording ${id}`);
        }
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

    console.log('[RECORDER] Recording scheduler started (30s interval)');
}

export function stopRecordingScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
}
