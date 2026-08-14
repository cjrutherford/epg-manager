import {
    DEFAULT_SYNC_CRON,
    describeCron,
    isValidCron,
    nextCronRun,
    parseCron,
    resolveSyncCron
} from '../cron-schedule';

describe('parseCron', () => {
    it('expands the default expression', () => {
        const fields = parseCron('0 2,14 * * *')!;
        expect(fields.minutes).toEqual([0]);
        expect(fields.hours).toEqual([2, 14]);
        expect(fields.daysOfMonth).toHaveLength(31);
        expect(fields.daysOfWeek).toHaveLength(7);
    });

    it('expands ranges and steps', () => {
        expect(parseCron('*/15 * * * *')!.minutes).toEqual([0, 15, 30, 45]);
        expect(parseCron('0 9-17 * * *')!.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
        expect(parseCron('0 0 * * 1-5')!.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it('treats 7 as Sunday', () => {
        expect(parseCron('0 0 * * 7')!.daysOfWeek).toEqual([0]);
    });

    it('rejects malformed expressions instead of half-parsing them', () => {
        for (const bad of ['', '0 2 * *', '0 2 * * * *', 'every day', '0 25 * * *', '99 * * * *', '0 5-2 * * *', '*/0 * * * *']) {
            expect(parseCron(bad)).toBeNull();
            expect(isValidCron(bad)).toBe(false);
        }
    });
});

describe('nextCronRun', () => {
    it('finds the next occurrence later the same day', () => {
        const from = new Date(2026, 7, 14, 9, 30);
        expect(nextCronRun('0 2,14 * * *', from)).toEqual(new Date(2026, 7, 14, 14, 0));
    });

    it('rolls over to the next day', () => {
        const from = new Date(2026, 7, 14, 15, 0);
        expect(nextCronRun('0 2,14 * * *', from)).toEqual(new Date(2026, 7, 15, 2, 0));
    });

    it('never returns the current minute', () => {
        const from = new Date(2026, 7, 14, 14, 0, 0, 0);
        expect(nextCronRun('0 2,14 * * *', from)).toEqual(new Date(2026, 7, 15, 2, 0));
    });

    it('honours a day-of-week restriction', () => {
        // 2026-08-14 is a Friday; the next Monday is the 17th.
        const from = new Date(2026, 7, 14, 12, 0);
        expect(nextCronRun('30 3 * * 1', from)).toEqual(new Date(2026, 7, 17, 3, 30));
    });

    it('matches either day field when both are restricted, as cron does', () => {
        // The 1st of the month, or any Monday, whichever comes first.
        const from = new Date(2026, 7, 14, 12, 0);
        expect(nextCronRun('0 0 1 * 1', from)).toEqual(new Date(2026, 7, 17, 0, 0));
    });

    it('returns null for an expression it cannot read', () => {
        expect(nextCronRun('not a cron', new Date())).toBeNull();
    });

    it('always returns a time in the future', () => {
        const from = new Date(2026, 7, 14, 13, 59);
        const next = nextCronRun('*/15 * * * *', from)!;
        expect(next.getTime()).toBeGreaterThan(from.getTime());
    });
});

describe('describeCron', () => {
    it('describes the default as the dashboard used to hardcode it', () => {
        expect(describeCron('0 2,14 * * *')).toBe('Every 12 hours (02:00, 14:00)');
    });

    it('describes a single daily run', () => {
        expect(describeCron('30 4 * * *')).toBe('Daily at 04:30');
    });

    it('describes an hourly run', () => {
        expect(describeCron('15 * * * *')).toBe('Hourly at :15');
    });

    it('describes several runs a day', () => {
        expect(describeCron('0 6,12,18 * * *')).toBe('3× daily (06:00, 12:00, 18:00)');
    });

    it('names the weekdays', () => {
        expect(describeCron('0 3 * * 1')).toBe('At 03:00 on Monday');
        expect(describeCron('0 3 * * 1-5')).toMatch(/Monday, Tuesday, Wednesday, Thursday, Friday/);
    });

    it('says so when it cannot read the expression', () => {
        expect(describeCron('nonsense')).toMatch(/^Invalid schedule/);
    });

    it('changes when the expression changes', () => {
        // The point of the slice: the reported schedule must follow the real one.
        expect(describeCron('0 2,14 * * *')).not.toBe(describeCron('0 3 * * *'));
    });
});

describe('resolveSyncCron', () => {
    it('uses a configured expression', () => {
        expect(resolveSyncCron('30 4 * * *')).toBe('30 4 * * *');
    });

    it('falls back rather than leaving the server unscheduled', () => {
        expect(resolveSyncCron(null)).toBe(DEFAULT_SYNC_CRON);
        expect(resolveSyncCron('  ')).toBe(DEFAULT_SYNC_CRON);
        expect(resolveSyncCron('garbage')).toBe(DEFAULT_SYNC_CRON);
    });
});
