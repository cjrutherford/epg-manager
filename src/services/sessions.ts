/**
 * Session and login-throttle policy.
 *
 * Kept free of the database and Express so the expiry, hashing and throttle
 * rules can be tested directly. The server owns storage; this owns the rules.
 */

import * as crypto from 'crypto';

/** Tokens are stored hashed, so a database read does not hand over live sessions. */
export function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
    return crypto.randomUUID();
}

/**
 * Constant-time password comparison.
 *
 * Both sides are hashed first so the buffers are always the same length —
 * timingSafeEqual throws on a length mismatch, and the length of a rejected
 * password should not be observable anyway.
 */
export function passwordMatches(provided: unknown, expected: string): boolean {
    if (typeof provided !== 'string') return false;
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(providedHash, expectedHash);
}

const WEAK_PASSWORDS = new Set(['admin', 'password', 'changeme', 'admin123', '']);

export function isWeakPassword(password: string): boolean {
    return WEAK_PASSWORDS.has(password.trim().toLowerCase());
}

export function isSessionValid(expiresAt: number | undefined, now: number): boolean {
    return typeof expiresAt === 'number' && expiresAt > now;
}

/**
 * Drop expired sessions from the in-memory index, returning the token hashes
 * removed so the caller can delete the same rows from storage.
 */
export function pruneExpiredSessions(sessions: Map<string, number>, now: number): string[] {
    const removed: string[] = [];
    for (const [tokenHash, expiresAt] of sessions.entries()) {
        if (!isSessionValid(expiresAt, now)) {
            sessions.delete(tokenHash);
            removed.push(tokenHash);
        }
    }
    return removed;
}

// ── Login throttling ──────────────────────────

export interface LoginThrottleOptions {
    /** Failures allowed inside the window before blocking. */
    maxFailures: number;
    /** Failures older than this stop counting. */
    windowMs: number;
    /** How long a block lasts once tripped. */
    blockMs: number;
}

export const DEFAULT_THROTTLE: LoginThrottleOptions = {
    maxFailures: 8,
    windowMs: 15 * 60 * 1000,
    blockMs: 15 * 60 * 1000
};

export interface LoginAttemptState {
    failures: number;
    windowStartedAt: number;
    blockedUntil: number;
}

export function createAttemptState(): LoginAttemptState {
    return { failures: 0, windowStartedAt: 0, blockedUntil: 0 };
}

export interface ThrottleVerdict {
    allowed: boolean;
    retryAfterMs: number;
}

export function checkThrottle(
    state: LoginAttemptState | undefined,
    now: number
): ThrottleVerdict {
    if (!state || state.blockedUntil <= now) {
        return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: state.blockedUntil - now };
}

/**
 * Record a failed attempt. Failures accumulate inside a rolling window; once
 * the ceiling is hit the caller is blocked for blockMs.
 */
export function registerFailure(
    state: LoginAttemptState | undefined,
    now: number,
    options: LoginThrottleOptions = DEFAULT_THROTTLE
): LoginAttemptState {
    const current = state ? { ...state } : createAttemptState();

    // Start a fresh window if the previous one has lapsed
    if (current.windowStartedAt === 0 || now - current.windowStartedAt > options.windowMs) {
        current.windowStartedAt = now;
        current.failures = 0;
    }

    current.failures += 1;

    if (current.failures >= options.maxFailures) {
        current.blockedUntil = now + options.blockMs;
        current.failures = 0;
        current.windowStartedAt = now;
    }

    return current;
}

/** A successful login clears the record for that caller. */
export function registerSuccess(): LoginAttemptState {
    return createAttemptState();
}

/** Drop throttle records that are neither blocking nor inside their window. */
export function pruneAttemptStates(
    states: Map<string, LoginAttemptState>,
    now: number,
    options: LoginThrottleOptions = DEFAULT_THROTTLE
): number {
    let removed = 0;
    for (const [key, state] of states.entries()) {
        const blockLapsed = state.blockedUntil <= now;
        const windowLapsed = now - state.windowStartedAt > options.windowMs;
        if (blockLapsed && windowLapsed) {
            states.delete(key);
            removed++;
        }
    }
    return removed;
}
