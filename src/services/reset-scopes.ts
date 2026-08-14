/**
 * Reset scopes — what a wipe touches, declared as data.
 *
 * The system holds two very different kinds of state. **User data** is what
 * someone configured or recorded; losing it is annoying but re-doable in
 * minutes. **Collection data** is the downloaded corpus and everything the
 * grabber has learned about source reliability; losing it costs a full
 * re-download of the iptv-org archives and re-learning every source statistic.
 *
 * The old single reset flattened both, which is why recovering from it was so
 * expensive. Each table belongs to exactly one class, and that assignment is
 * asserted against the live schema so a table added later cannot be silently
 * missed by every scope.
 */

export type ResetScope = 'guide' | 'user' | 'collection' | 'all';

/** Guide data — re-grabbable programme listings. */
export const GUIDE_TABLES = [
    'epg_programs',
    'epg_channels',
    'grab_logs'
] as const;

/** User data — configuration, curation and recordings. */
export const USER_TABLES = [
    'channels',
    'channels_staging',
    'settings',
    'manual_overrides',
    'metadata_overrides',
    'channel_favorites',
    'channel_hidden',
    'scheduled_recordings',
    'dvr_series_rules'
] as const;

/** Collection data — the downloaded corpus and learned source behaviour. */
export const COLLECTION_TABLES = [
    'iptv_org_map',
    'sources',
    'epg_source_channels',
    'epg_source_channels_staging',
    'source_validators',
    'source_credentials',
    'site_status',
    'channel_site_status',
    'channel_grab_status',
    'metadata_cache',
    'episode_metadata_cache',
    'tvmaze_cache',
    'sync_jobs'
] as const;

/**
 * Session state. Deliberately its own class: it is neither the user's content
 * nor the collector's corpus, and clearing it during a data reset would log the
 * admin out mid-flow — every following request would 401 and read as a bug.
 * Only the `all` scope touches it.
 */
export const SYSTEM_TABLES = [
    'admin_sessions'
] as const;

/** Files and directories under DB_DIR, by class. */
export const GUIDE_FILES = ['playlist.m3u', 'epg.xml'] as const;
export const USER_DIRS = ['recordings', 'streams'] as const;
export const COLLECTION_DIRS = ['iptv-org-epg', 'iptv-org-playlists', 'imdb-data', 'http-cache'] as const;

export interface ResetPlan {
    scope: ResetScope;
    tables: string[];
    files: string[];
    dirs: string[];
    /** One line the UI can show verbatim before asking for confirmation. */
    summary: string;
}

/**
 * Resolve a scope to the tables, files and directories it clears.
 *
 * `user` includes `guide` because guide rows are keyed to channels that are
 * about to disappear; leaving them would strand orphaned programmes.
 * `collection` is orthogonal — it can be rebuilt without touching what the
 * user configured.
 */
export function planReset(scope: ResetScope): ResetPlan {
    switch (scope) {
        case 'guide':
            return {
                scope,
                tables: [...GUIDE_TABLES],
                files: [...GUIDE_FILES],
                dirs: [],
                summary: 'Clears programme listings and grab history. Channels, playlists, recordings and downloaded source catalogues are kept.'
            };

        case 'user':
            return {
                scope,
                tables: [...GUIDE_TABLES, ...USER_TABLES],
                files: [...GUIDE_FILES],
                dirs: [...USER_DIRS],
                summary: 'Clears channels, settings, overrides, recordings and guide data. Downloaded source catalogues and learned source reliability are kept, so the next sync is fast.'
            };

        case 'collection':
            return {
                scope,
                tables: [...COLLECTION_TABLES],
                files: [],
                dirs: [...COLLECTION_DIRS],
                summary: 'Clears downloaded source catalogues, caches and learned source reliability. Your channels, settings and recordings are kept, but the next sync re-downloads everything.'
            };

        case 'all':
            return {
                scope,
                tables: [...GUIDE_TABLES, ...USER_TABLES, ...COLLECTION_TABLES, ...SYSTEM_TABLES],
                files: [...GUIDE_FILES],
                dirs: [...USER_DIRS, ...COLLECTION_DIRS],
                summary: 'Clears everything: channels, settings, recordings, guide data, downloaded catalogues, all caches and any signed-in sessions. The next sync starts from nothing.'
            };
    }
}

export function isResetScope(value: unknown): value is ResetScope {
    return value === 'guide' || value === 'user' || value === 'collection' || value === 'all';
}

export interface ScopeCoverage {
    covered: boolean;
    /** Live tables no scope would ever clear. */
    unassigned: string[];
    /** Tables assigned to more than one class. */
    duplicated: string[];
    /** Declared tables that no longer exist in the schema. */
    stale: string[];
}

/**
 * Check the scope declarations against the tables actually present. Guards the
 * invariant that every table belongs to exactly one class — a new table added
 * to the schema without being classified shows up here rather than quietly
 * surviving every reset.
 */
export function checkScopeCoverage(liveTables: string[]): ScopeCoverage {
    const declared: string[] = [...GUIDE_TABLES, ...USER_TABLES, ...COLLECTION_TABLES, ...SYSTEM_TABLES];
    const seen = new Map<string, number>();
    for (const table of declared) {
        seen.set(table, (seen.get(table) || 0) + 1);
    }

    const live = new Set(liveTables);
    const declaredSet = new Set(declared);

    return {
        covered: liveTables.every(table => declaredSet.has(table)),
        unassigned: liveTables.filter(table => !declaredSet.has(table)),
        duplicated: Array.from(seen.entries()).filter(([, count]) => count > 1).map(([table]) => table),
        stale: declared.filter(table => !live.has(table))
    };
}
