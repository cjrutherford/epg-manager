import {
    describeDestination,
    failureReason,
    formatBytes,
    isSeriesCandidate,
    parseEpgTime,
    schedulability,
    statusClass,
    statusLabel
} from '../dvr-format';

const NOW = Date.parse('2026-08-14T12:00:00Z');

describe('parseEpgTime', () => {
    it('reads XMLTV timestamps', () => {
        expect(parseEpgTime('20260814200000 +0000')?.toISOString()).toBe('2026-08-14T20:00:00.000Z');
    });

    it('applies the offset', () => {
        expect(parseEpgTime('20260814200000 +0200')?.toISOString()).toBe('2026-08-14T18:00:00.000Z');
    });

    it('tolerates a missing seconds field', () => {
        expect(parseEpgTime('202608142000 +0000')?.toISOString()).toBe('2026-08-14T20:00:00.000Z');
        expect(parseEpgTime('20260814200000')?.toISOString()).toBe('2026-08-14T20:00:00.000Z');
    });

    it('reads ISO', () => {
        expect(parseEpgTime('2026-08-14T20:00:00Z')?.toISOString()).toBe('2026-08-14T20:00:00.000Z');
    });

    it('returns null rather than an Invalid Date', () => {
        for (const bad of [null, undefined, '', '   ', 'tomorrow']) {
            expect(parseEpgTime(bad)).toBeNull();
        }
    });
});

describe('isSeriesCandidate', () => {
    it('accepts anything with episode metadata', () => {
        expect(isSeriesCandidate({ title: 'A', start: '', stop: '', episode_num: 'S01E01' })).toBe(true);
        expect(isSeriesCandidate({ title: 'A', start: '', stop: '', sub_title: 'Pilot' })).toBe(true);
    });

    it('accepts a show-like category that airs more than once', () => {
        const programmes = [
            { title: 'A', start: '', stop: '', category: 'Drama' },
            { title: 'A', start: '', stop: '', category: 'Drama' }
        ];
        expect(isSeriesCandidate(programmes[0], programmes)).toBe(true);
    });

    it('rejects a show-like category that airs only once', () => {
        const programme = { title: 'A', start: '', stop: '', category: 'Drama' };
        expect(isSeriesCandidate(programme, [programme])).toBe(false);
    });

    it('rejects a repeated title with no show-like category', () => {
        const programmes = [
            { title: 'A', start: '', stop: '' },
            { title: 'A', start: '', stop: '' }
        ];
        expect(isSeriesCandidate(programmes[0], programmes)).toBe(false);
    });

    it('rejects a film, however often it repeats', () => {
        const programmes = [
            { title: 'The Film', start: '', stop: '', category: 'Movie' },
            { title: 'The Film', start: '', stop: '', category: 'Movie' }
        ];
        expect(isSeriesCandidate(programmes[0], programmes)).toBe(false);
    });

    it('matches the title case-insensitively when counting repeats', () => {
        const programmes = [
            { title: ' the show ', start: '', stop: '', category: 'Comedy' },
            { title: 'The Show', start: '', stop: '', category: 'Comedy' }
        ];
        expect(isSeriesCandidate(programmes[0], programmes)).toBe(true);
    });

    it('rejects nothing at all', () => {
        expect(isSeriesCandidate(null)).toBe(false);
    });
});

describe('formatBytes', () => {
    it('scales through the units', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    });

    it('does not produce NaN for junk', () => {
        expect(formatBytes(NaN as any)).toBe('0 B');
        expect(formatBytes(null as any)).toBe('0 B');
        expect(formatBytes(-1)).toBe('0 B');
    });
});

describe('status vocabulary', () => {
    it('separates missed from failed', () => {
        expect(statusLabel('missed')).toBe('Missed');
        expect(statusLabel('failed')).toBe('Failed');
        expect(statusClass('missed')).not.toBe(statusClass('failed'));
    });

    it('does not paint a missed recording as an error', () => {
        expect(statusClass('missed')).toBe('badge-info');
        expect(statusClass('failed')).toBe('badge-danger');
    });

    it('covers both recorders\' statuses', () => {
        for (const status of ['scheduled', 'queued', 'recording', 'completed', 'missed', 'failed', 'cancelled']) {
            expect(statusLabel(status)).not.toBe('Unknown');
            expect(statusClass(status)).toMatch(/^badge-/);
        }
    });

    it('degrades gracefully on an unknown status', () => {
        expect(statusLabel('')).toBe('Unknown');
        expect(statusClass('something-new')).toBe('badge-primary');
    });
});

describe('failureReason', () => {
    it('reads the server spelling', () => {
        expect(failureReason({ error_message: 'The disk filled up' })).toBe('The disk filled up');
    });

    it('reads the browser recorder spelling', () => {
        expect(failureReason({ errorMessage: 'Tab closed' })).toBe('Tab closed');
    });

    it('is null when there is nothing to say', () => {
        expect(failureReason({ error_message: null })).toBeNull();
        expect(failureReason({})).toBeNull();
        expect(failureReason(null)).toBeNull();
    });
});

describe('schedulability', () => {
    const programme = (over: any = {}) => ({
        title: 'Show',
        start: '20260814200000 +0000',
        stop: '20260814210000 +0000',
        ...over
    });

    it('accepts an upcoming programme', () => {
        const result = schedulability(programme(), NOW);
        expect(result.ok).toBe(true);
        expect((result as any).start.toISOString()).toBe('2026-08-14T20:00:00.000Z');
    });

    it('refuses one that has finished, by name', () => {
        const result = schedulability(
            programme({ start: '20260814080000 +0000', stop: '20260814090000 +0000' }),
            NOW
        );
        expect(result).toEqual({ ok: false, reason: 'That programme has already finished' });
    });

    it('accepts one already underway', () => {
        const result = schedulability(
            programme({ start: '20260814110000 +0000', stop: '20260814130000 +0000' }),
            NOW
        );
        expect(result.ok).toBe(true);
    });

    it('refuses unusable times', () => {
        const result = schedulability(programme({ stop: 'later' }), NOW);
        expect(result.ok).toBe(false);
        expect((result as any).reason).toMatch(/no usable start and end time/);
    });
});

describe('describeDestination', () => {
    it('tells the user which recorder they got', () => {
        expect(describeDestination('server')).toBe('on the server');
        expect(describeDestination('browser')).toMatch(/browser/);
    });
});
