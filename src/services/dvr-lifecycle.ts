/**
 * DVR lifecycle policy — when a scheduled recording should start, when it has
 * been missed, and what a failure actually means.
 *
 * Kept pure so the decisions can be tested without ffmpeg, a clock or a
 * database. The recorder supplies the row, the padding and the time.
 */

/** A window shorter than this cannot produce anything playable. */
export const MIN_RECORDING_SECONDS = 10;

export interface RecordingPadding {
    /** Seconds to begin before the programme starts. */
    startSeconds: number;
    /** Seconds to keep recording after it ends. */
    endSeconds: number;
}

/**
 * Post-padding by default, pre-padding not.
 *
 * Broadcast schedules routinely overrun, so a couple of minutes at the end is
 * what a DVR is expected to do. Starting early is left off by default: it is
 * the more surprising of the two, since it overlaps whatever the channel was
 * showing before.
 */
export const DEFAULT_PADDING: RecordingPadding = {
    startSeconds: 0,
    endSeconds: 120
};

export interface RecordingWindow {
    startMs: number;
    endMs: number;
}

export type ScheduleAction =
    /** Not due yet — leave it alone. */
    | { action: 'wait' }
    /** Start now. `lateBySeconds` is how much of the programme is already gone. */
    | { action: 'start'; durationSeconds: number; lateBySeconds: number }
    /** The window closed without the recording running. */
    | { action: 'missed'; reason: string };

/** Apply padding to a programme's advertised times. */
export function applyPadding(window: RecordingWindow, padding: RecordingPadding): RecordingWindow {
    return {
        startMs: window.startMs - Math.max(0, padding.startSeconds) * 1000,
        endMs: window.endMs + Math.max(0, padding.endSeconds) * 1000
    };
}

/** Parse the ISO times stored on a scheduled recording, or null if unusable. */
export function parseWindow(startTime: string | null | undefined, endTime: string | null | undefined): RecordingWindow | null {
    const startMs = startTime ? Date.parse(String(startTime)) : NaN;
    const endMs = endTime ? Date.parse(String(endTime)) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    if (endMs <= startMs) return null;
    return { startMs, endMs };
}

function describeMissedWindow(window: RecordingWindow, now: number): string {
    const minutesAgo = Math.round((now - window.endMs) / 60000);
    if (minutesAgo < 60) {
        return `Missed — the recording window closed ${Math.max(1, minutesAgo)} minute(s) before the recorder reached it`;
    }
    const hoursAgo = Math.round(minutesAgo / 60);
    if (hoursAgo < 48) {
        return `Missed — the recording window closed about ${hoursAgo} hour(s) before the recorder reached it`;
    }
    return `Missed — the recording window closed about ${Math.round(hoursAgo / 24)} day(s) before the recorder reached it`;
}

/**
 * Decide what to do with a scheduled row.
 *
 * The case this exists for: the server is off when a programme airs. On the
 * next start the row is still `scheduled` with a start time in the past, and
 * the old scheduler dutifully launched ffmpeg against a window that had already
 * closed — producing "failed: Output file not found", which describes the
 * symptom and hides the cause.
 */
export function classifySchedule(
    window: RecordingWindow | null,
    now: number,
    padding: RecordingPadding = DEFAULT_PADDING
): ScheduleAction {
    if (!window) {
        return { action: 'missed', reason: 'Missed — this recording has no usable start and end time' };
    }

    const padded = applyPadding(window, padding);

    if (now < padded.startMs) return { action: 'wait' };

    const remainingSeconds = Math.floor((padded.endMs - now) / 1000);
    if (remainingSeconds < MIN_RECORDING_SECONDS) {
        return { action: 'missed', reason: describeMissedWindow(padded, now) };
    }

    return {
        action: 'start',
        durationSeconds: remainingSeconds,
        lateBySeconds: Math.max(0, Math.floor((now - padded.startMs) / 1000))
    };
}

// ── Failure classification ───────────────────

export interface FailureVerdict {
    /** Whether trying again could plausibly succeed. */
    retryable: boolean;
    /** What to show the user. */
    reason: string;
}

interface StderrRule {
    match: RegExp;
    retryable: boolean;
    reason: string;
}

/**
 * ffmpeg reports everything through exit code 1 and a line of stderr, so the
 * code alone cannot distinguish "this channel is gone" from "the network
 * blipped". Retrying the first five times, five seconds apart, wastes four
 * minutes and still ends in a message nobody can act on.
 */
const STDERR_RULES: StderrRule[] = [
    { match: /No space left on device/i, retryable: false, reason: 'The disk filled up while recording' },
    { match: /(HTTP error 401|401 Unauthorized)/i, retryable: false, reason: 'The stream rejected the request as unauthorised (401) — the source may need new credentials' },
    { match: /(HTTP error 403|403 Forbidden)/i, retryable: false, reason: 'The stream refused the connection (403 Forbidden) — it may be geo-blocked or need new credentials' },
    { match: /(HTTP error 404|404 Not Found)/i, retryable: false, reason: 'The stream URL returned 404 — the channel has probably moved or been removed' },
    { match: /(HTTP error 4[0-9]{2})/i, retryable: false, reason: 'The stream rejected the request and will not accept a retry' },
    { match: /(HTTP error 5[0-9]{2}|502 Bad Gateway|503 Service Unavailable)/i, retryable: true, reason: 'The stream server returned an error' },
    { match: /Protocol not found/i, retryable: false, reason: 'The stream URL uses a protocol ffmpeg cannot open' },
    { match: /Invalid data found when processing input/i, retryable: false, reason: 'The stream did not contain usable video' },
    { match: /(Server returned|Failed to open segment)/i, retryable: true, reason: 'The stream stopped delivering segments' },
    { match: /(Connection refused|Connection timed out|Network is unreachable|No route to host)/i, retryable: true, reason: 'The stream could not be reached' },
    { match: /(Name or service not known|Failed to resolve hostname|getaddrinfo)/i, retryable: true, reason: 'The stream host could not be resolved' },
    { match: /Immediate exit requested/i, retryable: true, reason: 'The recorder was interrupted' }
];

/**
 * Turn an ffmpeg exit into a verdict. `stderrTail` is the last of what the
 * process wrote — the only place the actual cause appears.
 */
export function classifyFfmpegFailure(code: number | null, stderrTail = ''): FailureVerdict {
    for (const rule of STDERR_RULES) {
        if (rule.match.test(stderrTail)) {
            return { retryable: rule.retryable, reason: rule.reason };
        }
    }

    if (code === null) {
        return { retryable: true, reason: 'The recorder process was terminated before it finished' };
    }

    return {
        retryable: true,
        reason: `The recorder exited unexpectedly (code ${code}) and the cause was not reported`
    };
}

/** Keep only the tail of ffmpeg's output — enough to classify, bounded in memory. */
export function appendStderr(buffer: string, chunk: string, maxChars = 4000): string {
    const combined = buffer + chunk;
    return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

export const MAX_RECORDING_ATTEMPTS = 5;

/**
 * Back off between retries instead of hammering every five seconds. A stream
 * that dropped because the source is restarting needs longer than a stream
 * that dropped a single segment.
 */
export function retryDelayMs(attempt: number, baseMs = 5000, capMs = 60000): number {
    const delay = baseMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(delay, capMs);
}

/**
 * Should another attempt be made? Permanent failures stop immediately — five
 * retries against a 404 only delay telling the user what is wrong.
 */
export function shouldRetry(verdict: FailureVerdict, attempt: number, maxAttempts = MAX_RECORDING_ATTEMPTS): boolean {
    return verdict.retryable && attempt < maxAttempts;
}

/** The message stored when retries are exhausted, so the count is visible. */
export function describeExhausted(verdict: FailureVerdict, attempts: number): string {
    return `${verdict.reason} (gave up after ${attempts} attempt${attempts === 1 ? '' : 's'})`;
}

// ── Padding settings ─────────────────────────

/** Read padding from raw setting values, falling back to the defaults. */
export function resolvePadding(startRaw: string | null, endRaw: string | null): RecordingPadding {
    const parse = (raw: string | null, fallback: number): number => {
        // Checked before Number(): `Number(null)` and `Number('')` are both 0,
        // which would read an unset setting as a deliberate "no padding".
        if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
        const parsed = Number(raw);
        // Zero is a legitimate choice, so only a non-finite or negative value
        // falls back to the default.
        return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
    };
    return {
        startSeconds: parse(startRaw, DEFAULT_PADDING.startSeconds),
        endSeconds: parse(endRaw, DEFAULT_PADDING.endSeconds)
    };
}
