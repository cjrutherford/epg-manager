/**
 * The queue behind every mutating background action.
 *
 * Before this, five endpoints each decided for themselves what to do when
 * something was already running: three rejected the caller outright, one
 * (`/api/rebuild-files`) ran regardless and rewrote the output files underneath
 * a sync, and the scheduled cron set a single boolean that could hold exactly
 * one deferred job and only ever a full sync.
 *
 * Kept pure so the decisions — run, queue, coalesce, reject — can be tested
 * without a server, a database or a clock.
 */

export const JOB_KINDS = ['full_sync', 'playlist_reload', 'grab', 'rebuild'] as const;

export type JobKind = typeof JOB_KINDS[number];

export function isJobKind(value: unknown): value is JobKind {
    return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

/** What a person should see this called. */
export const JOB_LABELS: Record<JobKind, string> = {
    full_sync: 'Full sync',
    playlist_reload: 'Playlist reload',
    grab: 'Guide grab',
    rebuild: 'Rebuild output files'
};

export interface QueuedJob {
    id: string;
    kind: JobKind;
    /** Who asked: `user` from the UI, `schedule` from cron. */
    trigger: 'user' | 'schedule';
    queuedAt: number;
}

export interface QueueState {
    running: QueuedJob | null;
    queue: QueuedJob[];
}

export function createQueueState(): QueueState {
    return { running: null, queue: [] };
}

export type EnqueueOutcome =
    /** Nothing was running; start it. */
    | { decision: 'run-now'; job: QueuedJob; message: string }
    /** Something is running; it will follow. */
    | { decision: 'queued'; job: QueuedJob; position: number; message: string }
    /** An equivalent job is already waiting, so this one folds into it. */
    | { decision: 'coalesced'; existing: QueuedJob; message: string }
    /** Refused — the queue is full. */
    | { decision: 'rejected'; reason: string; message: string };

export interface EnqueueOptions {
    maxQueueLength?: number;
    now?: number;
    idFactory?: () => string;
}

/**
 * A full sync does everything the narrower jobs do, so queueing a playlist
 * reload or a grab behind one that is already waiting adds nothing.
 */
const SUBSUMED_BY_FULL_SYNC: JobKind[] = ['playlist_reload', 'grab', 'rebuild'];

function coalescesWith(pending: QueuedJob, incoming: JobKind): boolean {
    if (pending.kind === incoming) return true;
    return pending.kind === 'full_sync' && SUBSUMED_BY_FULL_SYNC.includes(incoming);
}

let idCounter = 0;

function defaultId(): string {
    idCounter += 1;
    return `job_${Date.now()}_${idCounter}`;
}

/**
 * Decide what happens to a request. The state is mutated so the caller holds
 * one authoritative queue rather than reconstructing it.
 */
export function enqueueJob(
    state: QueueState,
    kind: JobKind,
    trigger: QueuedJob['trigger'] = 'user',
    options: EnqueueOptions = {}
): EnqueueOutcome {
    const maxQueueLength = options.maxQueueLength ?? 4;
    const now = options.now ?? Date.now();
    const makeId = options.idFactory ?? defaultId;

    const job: QueuedJob = { id: makeId(), kind, trigger, queuedAt: now };
    const label = JOB_LABELS[kind];

    if (!state.running) {
        state.running = job;
        return { decision: 'run-now', job, message: `${label} started.` };
    }

    // Fold into an equivalent job that is already waiting. Two clicks of
    // "Sync now" during a sync should mean one more sync, not two.
    const pending = state.queue.find(queued => coalescesWith(queued, kind));
    if (pending) {
        return {
            decision: 'coalesced',
            existing: pending,
            message: pending.kind === kind
                ? `${label} is already queued and will run when the current job finishes.`
                : `A full sync is already queued and covers this.`
        };
    }

    if (state.queue.length >= maxQueueLength) {
        return {
            decision: 'rejected',
            reason: 'queue-full',
            message: `Too many jobs are already waiting (${state.queue.length}). Try again once some have run.`
        };
    }

    state.queue.push(job);
    return {
        decision: 'queued',
        job,
        position: state.queue.length,
        message: `${label} queued behind ${JOB_LABELS[state.running.kind].toLowerCase()} (position ${state.queue.length}).`
    };
}

/** Finish the running job and hand back whatever runs next. */
export function completeRunning(state: QueueState): QueuedJob | null {
    state.running = state.queue.shift() ?? null;
    return state.running;
}

/**
 * Drop a queued job. The running job is not touched — stopping that is a
 * cancel, which the job itself has to honour.
 */
export function removeQueued(state: QueueState, jobId: string): QueuedJob | null {
    const index = state.queue.findIndex(job => job.id === jobId);
    if (index === -1) return null;
    return state.queue.splice(index, 1)[0];
}

/** Empty the queue, returning what was discarded. */
export function clearQueue(state: QueueState): QueuedJob[] {
    const dropped = state.queue.slice();
    state.queue.length = 0;
    return dropped;
}

/** A snapshot safe to serialise into an API response. */
export function describeQueue(state: QueueState): {
    running: (QueuedJob & { label: string }) | null;
    queued: (QueuedJob & { label: string; position: number })[];
} {
    return {
        running: state.running ? { ...state.running, label: JOB_LABELS[state.running.kind] } : null,
        queued: state.queue.map((job, index) => ({
            ...job,
            label: JOB_LABELS[job.kind],
            position: index + 1
        }))
    };
}
