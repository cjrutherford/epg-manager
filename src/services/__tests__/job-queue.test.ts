import {
    clearQueue,
    completeRunning,
    createQueueState,
    describeQueue,
    enqueueJob,
    isJobKind,
    removeQueued
} from '../job-queue';

let counter = 0;
const ids = () => `test_${++counter}`;
const opts = { now: 1_000, idFactory: ids };

beforeEach(() => { counter = 0; });

describe('isJobKind', () => {
    it('accepts the four real kinds', () => {
        for (const kind of ['full_sync', 'playlist_reload', 'grab', 'rebuild']) {
            expect(isJobKind(kind)).toBe(true);
        }
    });

    it('rejects anything else', () => {
        expect(isJobKind('drop_database')).toBe(false);
        expect(isJobKind(undefined)).toBe(false);
        expect(isJobKind(7)).toBe(false);
    });
});

describe('enqueueJob', () => {
    it('runs immediately when nothing is going on', () => {
        const state = createQueueState();
        const result = enqueueJob(state, 'full_sync', 'user', opts);

        expect(result.decision).toBe('run-now');
        expect(state.running?.kind).toBe('full_sync');
        expect(state.queue).toHaveLength(0);
    });

    it('queues a conflicting trigger instead of overlapping it', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        const result = enqueueJob(state, 'grab', 'user', opts);

        expect(result.decision).toBe('queued');
        expect(state.running?.kind).toBe('full_sync');
        expect(state.queue.map(j => j.kind)).toEqual(['grab']);
    });

    it('never runs two jobs at once', () => {
        const state = createQueueState();
        for (const kind of ['full_sync', 'grab', 'playlist_reload', 'rebuild'] as const) {
            enqueueJob(state, kind, 'user', opts);
        }
        expect(state.running).not.toBeNull();
        expect(state.queue.every(j => j.id !== state.running!.id)).toBe(true);
    });

    it('folds a repeat of the same kind into the one already waiting', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        enqueueJob(state, 'grab', 'user', opts);
        const result = enqueueJob(state, 'grab', 'user', opts);

        expect(result.decision).toBe('coalesced');
        expect(state.queue).toHaveLength(1);
    });

    it('folds narrower jobs into a queued full sync, which already covers them', () => {
        const state = createQueueState();
        enqueueJob(state, 'grab', 'user', opts);          // running
        enqueueJob(state, 'full_sync', 'user', opts);     // queued

        for (const kind of ['playlist_reload', 'grab', 'rebuild'] as const) {
            expect(enqueueJob(state, kind, 'user', opts).decision).toBe('coalesced');
        }
        expect(state.queue.map(j => j.kind)).toEqual(['full_sync']);
    });

    it('does not fold a full sync into a queued narrower job', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        enqueueJob(state, 'grab', 'user', opts);
        const result = enqueueJob(state, 'full_sync', 'user', opts);

        expect(result.decision).toBe('queued');
        expect(state.queue.map(j => j.kind)).toEqual(['grab', 'full_sync']);
    });

    it('refuses once the queue is full, and says why', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        enqueueJob(state, 'grab', 'user', { ...opts, maxQueueLength: 1 });
        const result = enqueueJob(state, 'playlist_reload', 'user', { ...opts, maxQueueLength: 1 });

        expect(result.decision).toBe('rejected');
        expect(result.message).toMatch(/Too many jobs/);
    });

    it('records who asked', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'schedule', opts);
        expect(state.running?.trigger).toBe('schedule');
    });

    it('produces a message worth showing for every decision', () => {
        const state = createQueueState();
        const first = enqueueJob(state, 'full_sync', 'user', opts);
        const second = enqueueJob(state, 'grab', 'user', opts);
        const third = enqueueJob(state, 'grab', 'user', opts);

        for (const outcome of [first, second, third]) {
            expect(outcome.message.length).toBeGreaterThan(10);
            expect(outcome.message).not.toMatch(/undefined/);
        }
        expect(second.message).toMatch(/queued behind full sync/i);
    });
});

describe('completeRunning', () => {
    it('promotes the next job in order', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        enqueueJob(state, 'grab', 'user', opts);
        enqueueJob(state, 'playlist_reload', 'user', opts);

        expect(completeRunning(state)?.kind).toBe('grab');
        expect(completeRunning(state)?.kind).toBe('playlist_reload');
        expect(completeRunning(state)).toBeNull();
        expect(state.running).toBeNull();
    });

    it('is safe on an empty queue', () => {
        const state = createQueueState();
        expect(completeRunning(state)).toBeNull();
    });
});

describe('removeQueued', () => {
    it('drops a waiting job', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        enqueueJob(state, 'grab', 'user', opts);
        const target = state.queue[0].id;

        expect(removeQueued(state, target)?.kind).toBe('grab');
        expect(state.queue).toHaveLength(0);
    });

    it('will not remove the running job', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        expect(removeQueued(state, state.running!.id)).toBeNull();
        expect(state.running).not.toBeNull();
    });

    it('returns null for an unknown id', () => {
        const state = createQueueState();
        expect(removeQueued(state, 'nope')).toBeNull();
    });
});

describe('clearQueue', () => {
    it('empties the queue but leaves the running job alone', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        enqueueJob(state, 'grab', 'user', opts);
        enqueueJob(state, 'playlist_reload', 'user', opts);

        expect(clearQueue(state)).toHaveLength(2);
        expect(state.queue).toHaveLength(0);
        expect(state.running?.kind).toBe('full_sync');
    });
});

describe('describeQueue', () => {
    it('labels everything and numbers the waiting jobs', () => {
        const state = createQueueState();
        enqueueJob(state, 'full_sync', 'user', opts);
        enqueueJob(state, 'grab', 'user', opts);

        const view = describeQueue(state);
        expect(view.running?.label).toBe('Full sync');
        expect(view.queued).toEqual([
            expect.objectContaining({ label: 'Guide grab', position: 1 })
        ]);
    });

    it('reports an idle queue as idle', () => {
        expect(describeQueue(createQueueState())).toEqual({ running: null, queued: [] });
    });
});
