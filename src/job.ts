import { eventBus } from './events';
import { db } from './db';
import {
    clearQueue,
    completeRunning,
    createQueueState,
    describeQueue,
    enqueueJob,
    removeQueued,
    type EnqueueOutcome,
    type JobKind,
    type QueuedJob
} from './services/job-queue';

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
    /** The job the queue considers in flight, with a human label. */
    activeJob?: { id: string; kind: string; label: string; trigger: string; queuedAt: number } | null;
    /** Jobs waiting behind it, in the order they will run. */
    queuedJobs?: { id: string; kind: string; label: string; trigger: string; queuedAt: number; position: number }[];
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
    // `running` already means "a job is in flight" in this shape, so the queue
    // view is reported under its own names rather than shadowing it.
    const view = describeQueue(queueState);
    return { ...currentJob, activeJob: view.running, queuedJobs: view.queued };
}

// ── The queue ────────────────────────────────
//
// One door for every mutating background action. Each endpoint used to make its
// own decision about what to do when something was already running, and they
// did not agree.

const queueState = createQueueState();

/** Handlers that actually perform the work, registered once at boot. */
const runners = new Map<JobKind, () => Promise<void>>();

export function registerJobRunner(kind: JobKind, runner: () => Promise<void>): void {
    runners.set(kind, runner);
}

let draining = false;

/**
 * Ask for a background job. Returns what happened so the caller can say so —
 * "started", "queued behind the full sync", "already queued".
 */
export function requestJob(kind: JobKind, trigger: QueuedJob['trigger'] = 'user'): EnqueueOutcome {
    const outcome = enqueueJob(queueState, kind, trigger);
    if (outcome.decision === 'run-now') {
        void drain();
    }
    return outcome;
}

/**
 * Run the queue to exhaustion, one job at a time. A failing job must not stop
 * the ones behind it, so each is caught here.
 */
async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
        while (queueState.running) {
            const job = queueState.running;
            const runner = runners.get(job.kind);
            if (!runner) {
                console.error(`[Job] No runner registered for '${job.kind}'`);
            } else {
                try {
                    await runner();
                } catch (e: any) {
                    console.error(`[Job] ${job.kind} failed:`, e?.message || e);
                }
            }
            completeRunning(queueState);
        }
    } finally {
        draining = false;
    }
}

/** Remove a job that has not started. The running one is stopped by cancelling. */
export function cancelQueuedJob(jobId: string): QueuedJob | null {
    return removeQueued(queueState, jobId);
}

/** Drop everything waiting, e.g. when the running job is cancelled. */
export function clearJobQueue(): QueuedJob[] {
    return clearQueue(queueState);
}

/** What is running right now, if anything. */
export function currentQueuedJob(): QueuedJob | null {
    return queueState.running;
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

