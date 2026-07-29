import { eventBus } from './events';
import { db } from './db';

export interface JobStatus {
    id?: string;
    type?: string;
    running: boolean;
    cancelRequested?: boolean;
    startTime: number | null;
    endTime: number | null;
    stats: {
        channelsProcessed: number;
        programsProcessed: number;
        channelsMatched: number;
        totalChannels: number;
        filesGenerated: string[];
        customGrabCount: number;
    } | null;
    progress: Record<string, {
        phase: string;
        message: string;
        current: number;
        total: number;
        completed?: boolean;
    }> | null;
    error?: string | null;
}

export const currentJob: JobStatus = {
    running: false,
    cancelRequested: false,
    startTime: null,
    endTime: null,
    stats: null,
    progress: null,
    error: null
};

// Listen for progress events to cache state
eventBus.on('progress', (data) => {
    if (currentJob.running) {
        if (!currentJob.progress) currentJob.progress = {};
        currentJob.progress[data.phase] = data;
    }
});

export async function startJob(type = 'full_sync'): Promise<string> {
    const jobId = `job_${Date.now()}`;
    currentJob.id = jobId;
    currentJob.type = type;
    currentJob.running = true;
    currentJob.cancelRequested = false;
    currentJob.startTime = Date.now();
    currentJob.endTime = null;
    currentJob.stats = null;
    currentJob.progress = null;
    currentJob.error = null;

    try {
        if (db && typeof db.execute === 'function') {
            await db.execute({
                sql: `INSERT INTO sync_jobs (id, type, status, cancel_requested, start_time) 
                      VALUES (?, ?, 'running', 0, ?)`,
                args: [jobId, type, currentJob.startTime]
            });
        }
    } catch (_) {}
    return jobId;
}

export async function requestJobCancel(): Promise<void> {
    if (currentJob.running) {
        currentJob.cancelRequested = true;
        if (currentJob.id) {
            try {
                if (db && typeof db.execute === 'function') {
                    await db.execute({
                        sql: `UPDATE sync_jobs SET cancel_requested = 1 WHERE id = ?`,
                        args: [currentJob.id]
                    });
                }
            } catch (_) {}
        }
    }
}

export async function completeJob(stats: JobStatus['stats'], error: string | null = null): Promise<void> {
    currentJob.running = false;
    currentJob.endTime = Date.now();
    currentJob.stats = stats;
    currentJob.error = error;

    if (currentJob.id) {
        try {
            if (db && typeof db.execute === 'function') {
                const status = error ? 'failed' : (currentJob.cancelRequested ? 'cancelled' : 'completed');
                await db.execute({
                    sql: `UPDATE sync_jobs 
                          SET status = ?, end_time = ?, stats_json = ?, progress_json = ?, error_message = ? 
                          WHERE id = ?`,
                    args: [
                        status,
                        currentJob.endTime,
                        stats ? JSON.stringify(stats) : null,
                        currentJob.progress ? JSON.stringify(currentJob.progress) : null,
                        error,
                        currentJob.id
                    ]
                });
            }
        } catch (_) {}
    }
}

export function getJobStatus(): JobStatus {
    return { ...currentJob };
}

/**
 * Load last job state on startup from SQLite
 */
export async function loadLastJobStateOnBoot(): Promise<void> {
    try {
        const result = await db.execute(
            `SELECT * FROM sync_jobs ORDER BY start_time DESC LIMIT 1`
        );
        if (result.rows.length > 0) {
            const row = result.rows[0];
            currentJob.id = String(row.id);
            currentJob.type = String(row.type);
            currentJob.running = row.status === 'running';
            currentJob.cancelRequested = Boolean(row.cancel_requested);
            currentJob.startTime = row.start_time ? Number(row.start_time) : null;
            currentJob.endTime = row.end_time ? Number(row.end_time) : null;
            currentJob.error = row.error_message ? String(row.error_message) : null;
            if (row.stats_json) {
                try { currentJob.stats = JSON.parse(String(row.stats_json)); } catch (_) {}
            }
            if (row.progress_json) {
                try { currentJob.progress = JSON.parse(String(row.progress_json)); } catch (_) {}
            }
        }
    } catch (e: any) {
        console.error('[Job] Failed to load last job state:', e.message);
    }
}

