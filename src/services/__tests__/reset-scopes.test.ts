import {
  checkScopeCoverage,
  COLLECTION_TABLES,
  GUIDE_TABLES,
  isResetScope,
  planReset,
  SYSTEM_TABLES,
  USER_TABLES
} from '../reset-scopes';

/** Every table created by initDb(), kept in sync with src/db.ts. */
const LIVE_SCHEMA = [
  'settings',
  'channels',
  'epg_channels',
  'epg_programs',
  'manual_overrides',
  'iptv_org_map',
  'sources',
  'epg_source_channels',
  'epg_source_channels_staging',
  'source_validators',
  'source_credentials',
  'site_status',
  'grab_logs',
  'metadata_cache',
  'episode_metadata_cache',
  'channel_grab_status',
  'channel_site_status',
  'tvmaze_cache',
  'scheduled_recordings',
  'dvr_series_rules',
  'metadata_overrides',
  'channel_favorites',
  'channel_hidden',
  'sync_jobs',
  'admin_sessions'
];

describe('scope coverage', () => {
  it('assigns every live table to exactly one class', () => {
    const coverage = checkScopeCoverage(LIVE_SCHEMA);

    expect(coverage.unassigned).toEqual([]);
    expect(coverage.duplicated).toEqual([]);
    expect(coverage.stale).toEqual([]);
    expect(coverage.covered).toBe(true);
  });

  it('reports a table that no scope would clear', () => {
    const coverage = checkScopeCoverage([...LIVE_SCHEMA, 'newly_added_table']);

    expect(coverage.covered).toBe(false);
    expect(coverage.unassigned).toEqual(['newly_added_table']);
  });

  it('keeps the three classes disjoint', () => {
    const guide = new Set<string>(GUIDE_TABLES);
    const user = new Set<string>(USER_TABLES);
    const collection = new Set<string>(COLLECTION_TABLES);

    for (const table of user) expect(guide.has(table)).toBe(false);
    for (const table of collection) {
      expect(guide.has(table)).toBe(false);
      expect(user.has(table)).toBe(false);
    }
  });
});

describe('planReset', () => {
  it('leaves the collection layer intact when resetting user data', () => {
    const plan = planReset('user');

    for (const table of COLLECTION_TABLES) {
      expect(plan.tables).not.toContain(table);
    }
    expect(plan.dirs).not.toContain('iptv-org-epg');
    expect(plan.dirs).not.toContain('iptv-org-playlists');
  });

  it('clears guide rows alongside user data so no programmes are orphaned', () => {
    const plan = planReset('user');

    for (const table of GUIDE_TABLES) {
      expect(plan.tables).toContain(table);
    }
  });

  it('leaves user data intact when rebuilding the collection cache', () => {
    const plan = planReset('collection');

    expect(plan.tables).not.toContain('channels');
    expect(plan.tables).not.toContain('settings');
    expect(plan.tables).not.toContain('scheduled_recordings');
    expect(plan.dirs).not.toContain('recordings');
  });

  it('touches only guide state in the narrowest scope', () => {
    const plan = planReset('guide');

    expect(plan.tables.sort()).toEqual([...GUIDE_TABLES].sort());
    expect(plan.dirs).toEqual([]);
  });

  it('covers the whole schema under the widest scope', () => {
    const plan = planReset('all');

    expect(plan.tables.sort()).toEqual(
      [...GUIDE_TABLES, ...USER_TABLES, ...COLLECTION_TABLES, ...SYSTEM_TABLES].sort()
    );
  });

  it('keeps you signed in through every scope except "all"', () => {
    for (const scope of ['guide', 'user', 'collection'] as const) {
      expect(planReset(scope).tables).not.toContain('admin_sessions');
    }
    expect(planReset('all').tables).toContain('admin_sessions');
  });

  it('never lists the same table twice', () => {
    for (const scope of ['guide', 'user', 'collection', 'all'] as const) {
      const tables = planReset(scope).tables;
      expect(new Set(tables).size).toBe(tables.length);
    }
  });
});

describe('isResetScope', () => {
  it('accepts only the declared scopes', () => {
    expect(isResetScope('user')).toBe(true);
    expect(isResetScope('everything')).toBe(false);
    expect(isResetScope(undefined)).toBe(false);
  });
});
