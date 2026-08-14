/**
 * Pure policy helpers for bounding the live stream proxy.
 *
 * Kept free of fs/child_process so the eviction and orphan rules can be
 * tested directly; StreamManager supplies the real clock and directory state.
 */

export interface StreamEvictionCandidate {
    id: string;
    lastAccess: number;
}

export interface StreamEvictionOptions {
    now: number;
    /** A stream must be idle at least this long before it can be evicted. */
    minIdleMs: number;
    /** Never evict these, even if they are the oldest. */
    protectIds?: Iterable<string>;
}

/**
 * Pick the least-recently-accessed stream that has been idle long enough to
 * evict. Returns null when every active stream is still in use — the caller
 * should refuse the new stream rather than interrupt someone who is watching.
 */
export function selectStreamToEvict(
    candidates: StreamEvictionCandidate[],
    options: StreamEvictionOptions
): string | null {
    const protectedIds = new Set(options.protectIds || []);
    let evictable: StreamEvictionCandidate | null = null;

    for (const candidate of candidates) {
        if (protectedIds.has(candidate.id)) continue;
        if (options.now - candidate.lastAccess < options.minIdleMs) continue;
        if (!evictable || candidate.lastAccess < evictable.lastAccess) {
            evictable = candidate;
        }
    }

    return evictable ? evictable.id : null;
}

export interface StreamDirCandidate {
    name: string;
    modifiedMs: number;
}

export interface OrphanScanOptions {
    now: number;
    /** Grace period so a directory being set up right now is never swept. */
    minAgeMs: number;
}

/**
 * Directories under the streams root with no matching active stream. These are
 * left behind when the process dies mid-stream, and nothing else reclaims them
 * until the next boot.
 */
export function findOrphanStreamDirs(
    dirs: StreamDirCandidate[],
    activeIds: Iterable<string>,
    options: OrphanScanOptions
): string[] {
    const active = new Set(activeIds);

    return dirs
        .filter(dir => !active.has(dir.name))
        .filter(dir => options.now - dir.modifiedMs >= options.minAgeMs)
        .map(dir => dir.name);
}
