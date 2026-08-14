/**
 * Pure policy helpers for recording file safety and retention.
 *
 * Path resolution and pruning decisions live here so they can be tested
 * without touching the filesystem or the database. Callers supply the real
 * clock, the real free-space reading, and perform the actual deletions.
 */

import * as path from 'path';

export interface ResolveOptions {
    /** Lower-case extensions the caller is willing to serve, e.g. ['.mp4']. */
    allowedExtensions?: string[];
}

/**
 * Resolve a caller-supplied recording filename to an absolute path inside
 * baseDir, or null if the input is not a plain filename within it.
 *
 * Anything carrying a directory component is rejected outright rather than
 * normalised away — a request for `../../local.db` is a bug or an attack, and
 * silently serving `local.db` would be the wrong answer to both.
 */
export function resolveRecordingPath(
    baseDir: string,
    filename: string,
    options: ResolveOptions = {}
): string | null {
    if (typeof filename !== 'string') return null;

    const candidate = filename.trim();
    if (!candidate) return null;
    if (candidate.includes('\0')) return null;

    // Reject rather than strip: a plain filename is unchanged by basename().
    if (path.basename(candidate) !== candidate) return null;
    if (candidate === '.' || candidate === '..') return null;

    if (options.allowedExtensions && options.allowedExtensions.length > 0) {
        const ext = path.extname(candidate).toLowerCase();
        if (!options.allowedExtensions.includes(ext)) return null;
    }

    const resolvedBase = path.resolve(baseDir);
    const resolved = path.resolve(resolvedBase, candidate);

    // Belt and braces: confirm containment after resolution.
    if (resolved !== path.join(resolvedBase, candidate)) return null;
    if (!resolved.startsWith(resolvedBase + path.sep)) return null;

    return resolved;
}

/** The retention modes, as data so the API can validate against them. */
export const RETENTION_MODES = ['off', 'age', 'size', 'low-space'] as const;

export type RetentionMode = typeof RETENTION_MODES[number];

export interface RetentionPolicy {
    mode: RetentionMode;
    /** Age mode: prune completed recordings older than this. */
    maxAgeDays: number;
    /** Size mode: total recording bytes to stay under. */
    budgetBytes: number;
    /** Floor used by low-space mode and by the pre-record space check. */
    minFreeBytes: number;
}

export interface RetentionCandidate {
    id: number;
    filename: string | null;
    status: string;
    /** When the recording finished — end time, falling back to creation. */
    completedAtMs: number;
    sizeBytes: number;
}

export interface RetentionContext {
    now: number;
    freeBytes: number;
}

export interface RetentionDecision {
    prune: RetentionCandidate[];
    reason: string;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
    mode: 'age',
    maxAgeDays: 30,
    budgetBytes: 50 * 1024 * 1024 * 1024,
    minFreeBytes: 2 * 1024 * 1024 * 1024
};

/**
 * Only finished recordings with a file on disk are ever eligible. Anything
 * scheduled or in flight is off limits regardless of policy.
 */
function isPrunable(candidate: RetentionCandidate): boolean {
    return candidate.status === 'completed' && !!candidate.filename;
}

function oldestFirst(candidates: RetentionCandidate[]): RetentionCandidate[] {
    return [...candidates].sort((left, right) => left.completedAtMs - right.completedAtMs);
}

/**
 * Decide which recordings to remove under the configured policy. Returns the
 * candidates to delete and a human-readable reason for the log.
 */
export function evaluateRetention(
    candidates: RetentionCandidate[],
    policy: RetentionPolicy,
    context: RetentionContext
): RetentionDecision {
    const eligible = oldestFirst(candidates.filter(isPrunable));

    if (policy.mode === 'off' || eligible.length === 0) {
        return { prune: [], reason: 'retention disabled' };
    }

    if (policy.mode === 'age') {
        const cutoff = context.now - policy.maxAgeDays * 24 * 60 * 60 * 1000;
        const prune = eligible.filter(candidate => candidate.completedAtMs < cutoff);
        return {
            prune,
            reason: `older than ${policy.maxAgeDays} day${policy.maxAgeDays === 1 ? '' : 's'}`
        };
    }

    if (policy.mode === 'size') {
        const total = eligible.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
        let over = total - policy.budgetBytes;
        if (over <= 0) return { prune: [], reason: 'within size budget' };

        const prune: RetentionCandidate[] = [];
        for (const candidate of eligible) {
            if (over <= 0) break;
            prune.push(candidate);
            over -= candidate.sizeBytes;
        }
        return { prune, reason: `over ${formatBytes(policy.budgetBytes)} budget` };
    }

    // low-space: only act when the disk is actually under pressure
    let deficit = policy.minFreeBytes - context.freeBytes;
    if (deficit <= 0) return { prune: [], reason: 'free space above floor' };

    const prune: RetentionCandidate[] = [];
    for (const candidate of eligible) {
        if (deficit <= 0) break;
        prune.push(candidate);
        deficit -= candidate.sizeBytes;
    }
    return { prune, reason: `free space below ${formatBytes(policy.minFreeBytes)} floor` };
}

/** True when there is enough headroom to start another recording. */
export function meetsFreeSpaceFloor(freeBytes: number, minFreeBytes: number): boolean {
    return freeBytes >= minFreeBytes;
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
