/**
 * Fetch policy for the acquisition core — pure decisions, no I/O.
 *
 * The point of putting these here is that "did we need to re-download this?"
 * and "should we retry?" are exactly the questions that were previously
 * answered implicitly and inconsistently per call site.
 */

export interface ConditionalState {
    etag?: string | null;
    lastModified?: string | null;
}

/**
 * Headers that let an unchanged feed cost a 304 instead of a re-download.
 * A 250 MB guide refreshed twice a day is the case this exists for.
 */
export function buildConditionalHeaders(state: ConditionalState | null | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!state) return headers;
    if (state.etag) headers['If-None-Match'] = state.etag;
    if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
    return headers;
}

/** 304 means the caller already has it; skip parsing entirely. */
export function isNotModified(status: number): boolean {
    return status === 304;
}

export function isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
}

/**
 * Worth trying again? Transient network and server conditions are; a 404 or a
 * 401 will be a 404 or a 401 next time too.
 */
export function isRetryableStatus(status: number): boolean {
    if (status === 408 || status === 425 || status === 429) return true;
    return status >= 500 && status < 600;
}

export function isRetryableError(error: { code?: string } | null | undefined): boolean {
    if (!error?.code) return false;
    return [
        'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN',
        'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_SOCKET_TIMEOUT'
    ].includes(error.code);
}

export interface BackoffOptions {
    baseMs: number;
    maxMs: number;
    /** Random spread applied on top, so retries from many sources don't align. */
    jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
    baseMs: 1000,
    maxMs: 30000,
    jitterRatio: 0.2
};

/**
 * Exponential backoff for attempt N (1-based), capped. `random` is injected so
 * the jitter is testable.
 */
export function backoffDelayMs(
    attempt: number,
    options: BackoffOptions = DEFAULT_BACKOFF,
    random: () => number = Math.random
): number {
    const exponent = Math.max(0, attempt - 1);
    const raw = Math.min(options.maxMs, options.baseMs * Math.pow(2, exponent));
    const jitter = raw * options.jitterRatio * random();
    return Math.round(Math.min(options.maxMs, raw + jitter));
}

/**
 * Honour Retry-After when the server sends one — it knows better than our
 * backoff curve. Supports both the seconds and HTTP-date forms.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
    if (!value) return null;
    const trimmed = value.trim();

    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed) * 1000;
    }
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
        return Math.max(0, asDate - now);
    }
    return null;
}

/** A source that keeps failing should stop being retried every cycle. */
export interface BreakerState {
    consecutiveFailures: number;
    openedAt: number;
}

export interface BreakerOptions {
    /** Failures before the breaker opens. */
    threshold: number;
    /** How long it stays open. */
    cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
    threshold: 3,
    cooldownMs: 20 * 60 * 60 * 1000
};

export function isBreakerOpen(
    state: BreakerState | undefined,
    now: number,
    options: BreakerOptions = DEFAULT_BREAKER
): boolean {
    if (!state || state.consecutiveFailures < options.threshold) return false;
    return now - state.openedAt < options.cooldownMs;
}

export function recordBreakerFailure(
    state: BreakerState | undefined,
    now: number,
    options: BreakerOptions = DEFAULT_BREAKER
): BreakerState {
    const failures = (state?.consecutiveFailures || 0) + 1;
    return {
        consecutiveFailures: failures,
        openedAt: failures >= options.threshold ? now : (state?.openedAt || 0)
    };
}

export function recordBreakerSuccess(): BreakerState {
    return { consecutiveFailures: 0, openedAt: 0 };
}

/**
 * Would this response blow the byte cap? Checked against Content-Length up
 * front and again as bytes arrive, since Content-Length can be absent or lie.
 */
export function exceedsByteCap(received: number, maxBytes: number | undefined): boolean {
    if (!maxBytes || maxBytes <= 0) return false;
    return received > maxBytes;
}
