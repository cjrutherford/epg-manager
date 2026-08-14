/**
 * DVR vocabulary shared by every surface that shows a recording.
 *
 * Deliberately free of Angular imports so it can be unit tested directly: the
 * admin screen and the Watch overlay each carried their own copy of this
 * logic, and the copies had drifted.
 */

export interface ProgrammeLike {
    title: string;
    /** XMLTV (`20260814200000 +0000`) or ISO. */
    start: string;
    stop: string;
    sub_title?: string | null;
    episode_num?: string | null;
    description?: string | null;
    desc?: string | null;
    category?: string | null;
    rating?: string | null;
    icon?: string | null;
}

export type RecordingDestination = 'server' | 'browser';

/** Parse an XMLTV or ISO timestamp. */
export function parseEpgTime(value: string | null | undefined): Date | null {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;

    if (trimmed.includes('-') && trimmed.includes(':')) {
        const parsed = Date.parse(trimmed);
        return Number.isNaN(parsed) ? null : new Date(parsed);
    }

    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(trimmed);
    if (!match) return null;

    const [, year, month, day, hour, minute, second, offset] = match;
    const zone = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : 'Z';
    const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second || '00'}${zone}`);
    return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Whether a programme looks like part of a series rather than a one-off.
 *
 * Both components already carried this, character for character; it is kept
 * verbatim so behaviour does not change under the consolidation.
 */
export function isSeriesCandidate(programme: ProgrammeLike | null | undefined, programmes: ProgrammeLike[] = []): boolean {
    if (!programme?.title) return false;
    if (programme.episode_num || programme.sub_title) return true;

    const category = String(programme.category || '').toLowerCase();
    const blockedCategories = ['movie', 'film', 'sports', 'news', 'event', 'special', 'shopping'];
    if (blockedCategories.some(blocked => category.includes(blocked))) return false;

    const showCategories = ['series', 'show', 'entertainment', 'comedy', 'drama', 'animation', 'kids', 'documentary'];
    const title = String(programme.title).trim().toLowerCase();
    const repeatCount = programmes.filter(candidate => String(candidate?.title || '').trim().toLowerCase() === title).length;
    return repeatCount > 1 && showCategories.some(showCategory => category.includes(showCategory));
}

export function formatBytes(bytes: number): string {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * One status vocabulary for both recorders. `missed` is distinct from `failed`:
 * a window that closed before the recorder reached it is not a fault, and
 * calling it one sent people looking for a bug that was not there.
 */
export function statusLabel(status: string): string {
    switch (status) {
        case 'scheduled': return 'Scheduled';
        case 'queued': return 'Queued';
        case 'recording': return 'Recording';
        case 'completed': return 'Completed';
        case 'missed': return 'Missed';
        case 'failed': return 'Failed';
        case 'cancelled': return 'Cancelled';
        default: return status || 'Unknown';
    }
}

/**
 * Mapped onto the badge classes that already exist globally, so nothing is
 * orphaned by the consolidation. `missed` and `cancelled` are informational:
 * neither is a fault, and neither should be red.
 */
export function statusClass(status: string): string {
    switch (status) {
        case 'recording': return 'badge-success';
        case 'scheduled':
        case 'queued': return 'badge-primary';
        case 'completed': return 'badge-warning';
        case 'failed': return 'badge-danger';
        case 'missed':
        case 'cancelled': return 'badge-info';
        default: return 'badge-primary';
    }
}

/**
 * The reason a recording is in the state it is, from either recorder — the
 * server spells it `error_message`, the browser recorder `errorMessage`.
 * A completed recording can carry one too; that is how a short recording
 * explains itself.
 */
export function failureReason(recording: any): string | null {
    if (!recording) return null;
    const reason = recording.error_message ?? recording.errorMessage;
    return reason ? String(reason) : null;
}

export function describeDestination(destination: RecordingDestination): string {
    return destination === 'server'
        ? 'on the server'
        : 'in this browser (keep the tab open)';
}

/** Whether a programme can still be recorded at all. */
export function schedulability(
    programme: ProgrammeLike,
    now: number
): { ok: true; start: Date; stop: Date } | { ok: false; reason: string } {
    const start = parseEpgTime(programme.start);
    const stop = parseEpgTime(programme.stop);

    if (!start || !stop) {
        return { ok: false, reason: 'That programme has no usable start and end time' };
    }
    if (stop.getTime() <= now) {
        return { ok: false, reason: 'That programme has already finished' };
    }
    return { ok: true, start, stop };
}
