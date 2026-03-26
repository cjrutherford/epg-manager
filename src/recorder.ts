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
 * Start recording a stream to a file
 */
export async function startRecording(recordingId: number): Promise<void> {
    const result = await db.execute({
        sql: 'SELECT * FROM scheduled_recordings WHERE id = ?',
        args: [recordingId],
    });

    if (result.rows.length === 0) {
        throw new Error(`Recording ${recordingId} not found`);
    }

    const rec = result.rows[0];
    const streamUrl = rec.stream_url as string;
    const endTime = new Date(rec.end_time as string);
    const now = new Date();

    // Calculate duration in seconds
    const durationSec = Math.max(60, Math.floor((endTime.getTime() - now.getTime()) / 1000));

    // Generate filename
    const sanitize = (s: string) => (s || 'recording').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const filename = `${sanitize(rec.program_title as string)}_${Date.now()}.mp4`;
    const outputPath = path.join(getRecordingsDir(), filename);

    // Update status to recording
    await db.execute({
        sql: 'UPDATE scheduled_recordings SET status = ?, filename = ? WHERE id = ?',
        args: ['recording', filename, recordingId],
    });

    console.log(`[RECORDER] Starting recording ${recordingId}: "${rec.program_title}" (${durationSec}s)`);

    // Spawn ffmpeg
    const ffmpeg = spawn('ffmpeg', [
        '-y',                  // Overwrite output
        '-i', streamUrl,       // Input stream
        '-t', String(durationSec), // Duration
        '-c', 'copy',          // Copy codec (no re-encoding)
        '-movflags', '+faststart', // Web-optimized MP4
        '-f', 'mp4',
        outputPath,
    ], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcesses.set(recordingId, ffmpeg);

    ffmpeg.stderr?.on('data', (data: Buffer) => {
        // ffmpeg outputs progress to stderr — we just log it
        const line = data.toString().trim();
        if (line.includes('frame=') || line.includes('time=')) {
            // Progress update — can be emitted via events if needed
        }
    });

    ffmpeg.on('close', async (code: number | null) => {
        activeProcesses.delete(recordingId);

        if (code === 0 || code === 255) {
            // Success (255 = killed, which is expected for manual stops)
            try {
                const stats = fs.statSync(outputPath);
                await db.execute({
                    sql: 'UPDATE scheduled_recordings SET status = ?, file_size = ? WHERE id = ? AND status = ?',
                    args: ['completed', stats.size, recordingId, 'recording'],
                });
                console.log(`[RECORDER] Recording ${recordingId} completed: ${filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
            } catch (e: any) {
                await db.execute({
                    sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
                    args: ['failed', `File stat error: ${e.message}`, recordingId],
                });
            }
        } else {
            await db.execute({
                sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ? AND status = ?',
                args: ['failed', `ffmpeg exited with code ${code}`, recordingId, 'recording'],
            });
            console.error(`[RECORDER] Recording ${recordingId} failed with code ${code}`);
            // Cleanup partial file
            try { fs.unlinkSync(outputPath); } catch (_) { }
        }
    });

    ffmpeg.on('error', async (err: Error) => {
        activeProcesses.delete(recordingId);
        await db.execute({
            sql: 'UPDATE scheduled_recordings SET status = ?, error_message = ? WHERE id = ?',
            args: ['failed', `ffmpeg error: ${err.message}`, recordingId],
        });
        console.error(`[RECORDER] Recording ${recordingId} error:`, err.message);
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
        // Delete file if exists
        if (rec.filename) {
            const filePath = path.join(getRecordingsDir(), rec.filename as string);
            try { fs.unlinkSync(filePath); } catch (_) { }
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
