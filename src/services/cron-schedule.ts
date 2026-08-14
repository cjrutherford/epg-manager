/**
 * Cron parsing, just enough to tell the truth about the sync schedule.
 *
 * node-cron runs the schedule but will not say when it next fires or what the
 * expression means, so the dashboard reported two hardcoded strings — one that
 * happened to match the cron, and one ("Weekly Playlist Sync: Disabled") for a
 * job that does not exist. Changing the cron would not have changed either.
 */

export interface CronFields {
    minutes: number[];
    hours: number[];
    daysOfMonth: number[];
    months: number[];
    daysOfWeek: number[];
}

interface FieldSpec {
    min: number;
    max: number;
}

const SPECS: Record<keyof CronFields, FieldSpec> = {
    minutes: { min: 0, max: 59 },
    hours: { min: 0, max: 23 },
    daysOfMonth: { min: 1, max: 31 },
    months: { min: 1, max: 12 },
    daysOfWeek: { min: 0, max: 6 }
};

const ORDER: (keyof CronFields)[] = ['minutes', 'hours', 'daysOfMonth', 'months', 'daysOfWeek'];

/** Expand one field (`*`, `5`, `1-4`, `*\/15`, `2,14`) into the values it matches. */
function expandField(raw: string, spec: FieldSpec): number[] | null {
    const values = new Set<number>();

    for (const part of raw.split(',')) {
        const piece = part.trim();
        if (!piece) return null;

        const [rangePart, stepPart] = piece.split('/');
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (!Number.isInteger(step) || step < 1) return null;

        let start: number;
        let end: number;

        if (rangePart === '*') {
            start = spec.min;
            end = spec.max;
        } else if (rangePart.includes('-')) {
            const [a, b] = rangePart.split('-');
            start = Number(a);
            end = Number(b);
        } else {
            start = Number(rangePart);
            end = stepPart === undefined ? start : spec.max;
        }

        if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
        if (start < spec.min || end > spec.max || start > end) return null;

        for (let v = start; v <= end; v += step) values.add(v);
    }

    return values.size > 0 ? [...values].sort((a, b) => a - b) : null;
}

/** Parse a standard five-field expression, or null if it is not one we can honour. */
export function parseCron(expression: string): CronFields | null {
    if (!expression) return null;
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const fields = {} as CronFields;
    for (let i = 0; i < ORDER.length; i++) {
        const key = ORDER[i];
        // Sunday is both 0 and 7 in common usage; normalise before expanding.
        const raw = key === 'daysOfWeek' ? parts[i].replace(/7/g, '0') : parts[i];
        const values = expandField(raw, SPECS[key]);
        if (!values) return null;
        fields[key] = values;
    }
    return fields;
}

export function isValidCron(expression: string): boolean {
    return parseCron(expression) !== null;
}

function matchesFields(fields: CronFields, date: Date): boolean {
    if (!fields.minutes.includes(date.getMinutes())) return false;
    if (!fields.hours.includes(date.getHours())) return false;
    if (!fields.months.includes(date.getMonth() + 1)) return false;

    // Cron's day rule: when both day fields are restricted, either may match.
    const domRestricted = fields.daysOfMonth.length !== 31;
    const dowRestricted = fields.daysOfWeek.length !== 7;
    const domMatch = fields.daysOfMonth.includes(date.getDate());
    const dowMatch = fields.daysOfWeek.includes(date.getDay());

    if (domRestricted && dowRestricted) return domMatch || dowMatch;
    if (domRestricted) return domMatch;
    if (dowRestricted) return dowMatch;
    return true;
}

/** How far ahead to look before giving up. Covers a "29 February" expression. */
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

/** The next time this expression fires after `from`, or null if it never does. */
export function nextCronRun(expression: string, from: Date = new Date()): Date | null {
    const fields = parseCron(expression);
    if (!fields) return null;

    const cursor = new Date(from.getTime());
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);

    for (let i = 0; i < SEARCH_LIMIT_MINUTES; i++) {
        if (matchesFields(fields, cursor)) return cursor;
        cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return null;
}

function formatTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isEveryValue(values: number[], spec: FieldSpec): boolean {
    return values.length === spec.max - spec.min + 1;
}

/** Describe an expression the way a person would say it. */
export function describeCron(expression: string): string {
    const fields = parseCron(expression);
    if (!fields) return `Invalid schedule (${expression})`;

    const everyMinute = isEveryValue(fields.minutes, SPECS.minutes);
    const everyHour = isEveryValue(fields.hours, SPECS.hours);
    const everyDom = isEveryValue(fields.daysOfMonth, SPECS.daysOfMonth);
    const everyDow = isEveryValue(fields.daysOfWeek, SPECS.daysOfWeek);
    const everyMonth = isEveryValue(fields.months, SPECS.months);

    let cadence: string;
    if (everyMinute && everyHour) {
        cadence = 'Every minute';
    } else if (everyHour && fields.minutes.length === 1) {
        cadence = `Hourly at :${String(fields.minutes[0]).padStart(2, '0')}`;
    } else if (everyMinute) {
        cadence = `Every minute during ${fields.hours.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}`;
    } else {
        const times = [];
        for (const hour of fields.hours) {
            for (const minute of fields.minutes) times.push(formatTime(hour, minute));
        }
        // Two runs a day is the common case and reads better as an interval.
        if (times.length === 2 && everyDom && everyDow && everyMonth) {
            const gap = (fields.hours[1] - fields.hours[0]);
            if (gap === 12) return `Every 12 hours (${times.join(', ')})`;
        }
        cadence = times.length === 1 ? `Daily at ${times[0]}` : `${times.length}× daily (${times.join(', ')})`;
    }

    const qualifiers: string[] = [];
    if (!everyDow) {
        qualifiers.push(`on ${fields.daysOfWeek.map(d => DAY_NAMES[d]).join(', ')}`);
    }
    if (!everyDom) {
        qualifiers.push(`on day ${fields.daysOfMonth.join(', ')} of the month`);
    }
    if (!everyMonth) {
        qualifiers.push(`in month ${fields.months.join(', ')}`);
    }

    // "Daily at 02:00 on Monday" reads wrong; drop the daily framing.
    if (qualifiers.length > 0 && cadence.startsWith('Daily at ')) {
        cadence = `At ${cadence.slice('Daily at '.length)}`;
    }

    return [cadence, ...qualifiers].join(' ');
}

/** The default automation cadence: 02:00 and 14:00 every day. */
export const DEFAULT_SYNC_CRON = '0 2,14 * * *';

/** Fall back to the default rather than leaving the server with no schedule. */
export function resolveSyncCron(raw: string | null | undefined): string {
    const candidate = (raw || '').trim();
    return isValidCron(candidate) ? candidate : DEFAULT_SYNC_CRON;
}
