import {
    appendStderr,
    applyPadding,
    classifyFfmpegFailure,
    classifySchedule,
    DEFAULT_PADDING,
    describeExhausted,
    MIN_RECORDING_SECONDS,
    parseWindow,
    resolvePadding,
    retryDelayMs,
    shouldRetry
} from '../dvr-lifecycle';

const NOW = Date.parse('2026-08-14T20:00:00Z');
const NO_PADDING = { startSeconds: 0, endSeconds: 0 };

describe('parseWindow', () => {
    it('parses valid times', () => {
        expect(parseWindow('2026-08-14T20:00:00Z', '2026-08-14T21:00:00Z')).toEqual({
            startMs: Date.parse('2026-08-14T20:00:00Z'),
            endMs: Date.parse('2026-08-14T21:00:00Z')
        });
    });

    it('rejects an end at or before the start', () => {
        expect(parseWindow('2026-08-14T21:00:00Z', '2026-08-14T21:00:00Z')).toBeNull();
        expect(parseWindow('2026-08-14T21:00:00Z', '2026-08-14T20:00:00Z')).toBeNull();
    });

    it('rejects unusable input', () => {
        expect(parseWindow(null, '2026-08-14T21:00:00Z')).toBeNull();
        expect(parseWindow('later', 'tomorrow')).toBeNull();
    });
});

describe('applyPadding', () => {
    it('widens both ends', () => {
        const padded = applyPadding(
            { startMs: NOW, endMs: NOW + 3600_000 },
            { startSeconds: 60, endSeconds: 120 }
        );
        expect(padded.startMs).toBe(NOW - 60_000);
        expect(padded.endMs).toBe(NOW + 3600_000 + 120_000);
    });

    it('ignores negative padding rather than shrinking the window', () => {
        const padded = applyPadding(
            { startMs: NOW, endMs: NOW + 3600_000 },
            { startSeconds: -600, endSeconds: -600 }
        );
        expect(padded).toEqual({ startMs: NOW, endMs: NOW + 3600_000 });
    });
});

describe('classifySchedule', () => {
    const window = (startOffsetMs: number, durationMs = 3600_000) => ({
        startMs: NOW + startOffsetMs,
        endMs: NOW + startOffsetMs + durationMs
    });

    it('waits for a programme that has not started', () => {
        expect(classifySchedule(window(600_000), NOW, NO_PADDING)).toEqual({ action: 'wait' });
    });

    it('starts one that is due, for its full length', () => {
        const result = classifySchedule(window(0), NOW, NO_PADDING);
        expect(result).toEqual({ action: 'start', durationSeconds: 3600, lateBySeconds: 0 });
    });

    it('starts a programme already underway, for what is left', () => {
        const result = classifySchedule(window(-600_000), NOW, NO_PADDING);
        expect(result).toEqual({ action: 'start', durationSeconds: 3000, lateBySeconds: 600 });
    });

    it('reports a closed window as missed, not as a failure', () => {
        const result = classifySchedule(window(-7200_000), NOW, NO_PADDING);
        expect(result.action).toBe('missed');
        expect((result as any).reason).toMatch(/^Missed —/);
    });

    it('scales the missed message from minutes to days', () => {
        const minutes = classifySchedule(window(-3600_000 - 600_000), NOW, NO_PADDING) as any;
        expect(minutes.reason).toMatch(/minute\(s\)/);

        const hours = classifySchedule(window(-3600_000 - 5 * 3600_000), NOW, NO_PADDING) as any;
        expect(hours.reason).toMatch(/hour\(s\)/);

        const days = classifySchedule(window(-3600_000 - 5 * 86400_000), NOW, NO_PADDING) as any;
        expect(days.reason).toMatch(/day\(s\)/);
    });

    it('treats a sliver of remaining time as missed', () => {
        const endsIn = (MIN_RECORDING_SECONDS - 1) * 1000;
        const result = classifySchedule(
            { startMs: NOW - 3600_000, endMs: NOW + endsIn },
            NOW,
            NO_PADDING
        );
        expect(result.action).toBe('missed');
    });

    it('starts when exactly the minimum is left', () => {
        const result = classifySchedule(
            { startMs: NOW - 3600_000, endMs: NOW + MIN_RECORDING_SECONDS * 1000 },
            NOW,
            NO_PADDING
        );
        expect(result.action).toBe('start');
    });

    it('treats a row with unusable times as missed', () => {
        const result = classifySchedule(null, NOW);
        expect(result.action).toBe('missed');
        expect((result as any).reason).toMatch(/no usable start and end time/);
    });

    // ── padding ──
    it('starts early by the pre-padding', () => {
        const soon = window(60_000);
        expect(classifySchedule(soon, NOW, NO_PADDING)).toEqual({ action: 'wait' });
        expect(classifySchedule(soon, NOW, { startSeconds: 120, endSeconds: 0 }).action).toBe('start');
    });

    it('adds the post-padding to the recorded duration', () => {
        const result = classifySchedule(window(0), NOW, { startSeconds: 0, endSeconds: 180 });
        expect(result).toMatchObject({ action: 'start', durationSeconds: 3780 });
    });

    it('keeps a window alive that post-padding still covers', () => {
        const justEnded = { startMs: NOW - 3600_000, endMs: NOW - 60_000 };
        expect(classifySchedule(justEnded, NOW, NO_PADDING).action).toBe('missed');
        expect(classifySchedule(justEnded, NOW, { startSeconds: 0, endSeconds: 300 }).action).toBe('start');
    });

    it('defaults to post-padding only', () => {
        expect(DEFAULT_PADDING.startSeconds).toBe(0);
        expect(DEFAULT_PADDING.endSeconds).toBeGreaterThan(0);
    });
});

describe('classifyFfmpegFailure', () => {
    it('does not retry a 404', () => {
        const verdict = classifyFfmpegFailure(1, "[http @ 0x5] HTTP error 404 Not Found\nx.m3u8: Server returned 404");
        expect(verdict.retryable).toBe(false);
        expect(verdict.reason).toMatch(/404/);
    });

    it('does not retry a 403', () => {
        expect(classifyFfmpegFailure(1, 'HTTP error 403 Forbidden').retryable).toBe(false);
    });

    it('does not retry an unauthorised stream', () => {
        const verdict = classifyFfmpegFailure(1, 'HTTP error 401 Unauthorized');
        expect(verdict.retryable).toBe(false);
        expect(verdict.reason).toMatch(/credentials/);
    });

    it('does not retry a full disk', () => {
        const verdict = classifyFfmpegFailure(1, 'av_interleaved_write_frame(): No space left on device');
        expect(verdict.retryable).toBe(false);
        expect(verdict.reason).toMatch(/disk filled up/);
    });

    it('retries a server-side error', () => {
        expect(classifyFfmpegFailure(1, 'HTTP error 503 Service Unavailable').retryable).toBe(true);
    });

    it('retries a network failure', () => {
        expect(classifyFfmpegFailure(1, 'tcp://host:80: Connection timed out').retryable).toBe(true);
        expect(classifyFfmpegFailure(1, 'Name or service not known').retryable).toBe(true);
    });

    it('retries an unexplained exit, and names the code', () => {
        const verdict = classifyFfmpegFailure(1, 'frame= 200 fps=25');
        expect(verdict.retryable).toBe(true);
        expect(verdict.reason).toMatch(/code 1/);
    });

    it('handles a process killed without a code', () => {
        const verdict = classifyFfmpegFailure(null, '');
        expect(verdict.retryable).toBe(true);
        expect(verdict.reason).toMatch(/terminated/);
    });

    it('always produces something a person can read', () => {
        for (const tail of ['', 'garbage', 'HTTP error 404 Not Found', 'No space left on device']) {
            const verdict = classifyFfmpegFailure(1, tail);
            expect(verdict.reason.length).toBeGreaterThan(10);
            expect(verdict.reason).not.toMatch(/^Output file not found$/);
        }
    });
});

describe('appendStderr', () => {
    it('accumulates while under the cap', () => {
        expect(appendStderr('one ', 'two', 100)).toBe('one two');
    });

    it('keeps the tail, which is where the cause is', () => {
        const kept = appendStderr('x'.repeat(4000), 'HTTP error 404 Not Found', 100);
        expect(kept.length).toBe(100);
        expect(kept).toContain('404 Not Found');
    });
});

describe('retry policy', () => {
    it('backs off instead of hammering', () => {
        expect(retryDelayMs(1)).toBe(5000);
        expect(retryDelayMs(2)).toBe(10000);
        expect(retryDelayMs(3)).toBe(20000);
    });

    it('caps the delay', () => {
        expect(retryDelayMs(20)).toBe(60000);
    });

    it('stops immediately on a permanent failure', () => {
        expect(shouldRetry({ retryable: false, reason: 'gone' }, 1)).toBe(false);
    });

    it('retries a transient failure up to the limit', () => {
        expect(shouldRetry({ retryable: true, reason: 'blip' }, 1)).toBe(true);
        expect(shouldRetry({ retryable: true, reason: 'blip' }, 4)).toBe(true);
        expect(shouldRetry({ retryable: true, reason: 'blip' }, 5)).toBe(false);
    });

    it('says how many attempts were made', () => {
        expect(describeExhausted({ retryable: true, reason: 'The stream could not be reached' }, 5))
            .toBe('The stream could not be reached (gave up after 5 attempts)');
        expect(describeExhausted({ retryable: false, reason: 'Gone' }, 1)).toMatch(/1 attempt\)/);
    });
});

describe('resolvePadding', () => {
    it('reads configured values', () => {
        expect(resolvePadding('30', '300')).toEqual({ startSeconds: 30, endSeconds: 300 });
    });

    it('treats zero as a choice, not as missing', () => {
        expect(resolvePadding('0', '0')).toEqual({ startSeconds: 0, endSeconds: 0 });
    });

    it('falls back when unset or nonsense', () => {
        expect(resolvePadding(null, null)).toEqual(DEFAULT_PADDING);
        expect(resolvePadding('soon', '-5')).toEqual(DEFAULT_PADDING);
    });
});
