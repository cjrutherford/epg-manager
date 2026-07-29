import { createClient } from "@libsql/client";
import * as fs from 'fs';
import * as path from 'path';

// Ensure data dir exists
export const DB_DIR = process.env.DB_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const dbPath = path.join(DB_DIR, 'local.db');
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, '');
}

export const db = createClient({
  url: `file:${dbPath}`,
});

export async function initDb() {
  await db.execute('PRAGMA journal_mode = WAL;');
  await db.execute('PRAGMA synchronous = NORMAL;');
  await db.execute('PRAGMA busy_timeout = 5000;');
  await db.execute('PRAGMA cache_size = -4000;');
  await db.execute('PRAGMA journal_size_limit = 67108864;');
  await db.execute('PRAGMA temp_store = MEMORY;');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT,
        group_title TEXT,
        url TEXT,
        tvg_id TEXT,
        tvg_name TEXT,
        tvg_logo TEXT,
        lang TEXT,
        matched_epg_id TEXT,
        match_type TEXT,
        enabled INTEGER DEFAULT 1,
        channel_number INTEGER
    )
  `);

  try { await db.execute("ALTER TABLE channels ADD COLUMN lang TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE channels ADD COLUMN match_type TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE channels ADD COLUMN enabled INTEGER DEFAULT 1"); } catch (e) { }
  try { await db.execute("ALTER TABLE channels ADD COLUMN channel_number INTEGER"); } catch (e) { }
  try { await db.execute("ALTER TABLE channels ADD COLUMN source_url TEXT"); } catch (e) { }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS epg_channels (
        id TEXT,
        source TEXT,
        display_name TEXT,
        icon TEXT,
        PRIMARY KEY (id, source)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS epg_programs (
        channel_id TEXT,
        source TEXT,
        start TEXT,
        stop TEXT,
        title TEXT,
        desc TEXT,
        sub_title TEXT,
        episode_num TEXT,
        category TEXT,
        rating TEXT,
        icon TEXT
    )
  `);

  // Add new columns for existing databases
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN sub_title TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN episode_num TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN category TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN rating TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN icon TEXT"); } catch (e) { }

  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_programs_channel ON epg_programs(channel_id, source)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_programs_times ON epg_programs(start, stop)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_programs_title ON epg_programs(title)");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS manual_overrides (
        channel_id TEXT PRIMARY KEY,
        epg_id TEXT
    )
  `);

  // Drops and Recreates for updated schema removed to prevent clearing on every initialization

  await db.execute(`
    CREATE TABLE IF NOT EXISTS iptv_org_map (
        name TEXT,
        xmltv_id TEXT,
        lang TEXT,
        site TEXT,
        site_id TEXT,
        PRIMARY KEY (name, xmltv_id)
    )
  `);

  await db.execute("CREATE INDEX IF NOT EXISTS idx_iptv_map_name ON iptv_org_map(name)");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS epg_sources (
        key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        site TEXT NOT NULL,
        label TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        grab_capable INTEGER DEFAULT 1,
        channel_count_estimate INTEGER,
        imported_rows INTEGER DEFAULT 0,
        last_sync_at INTEGER,
        last_sync_status TEXT,
        last_error TEXT,
        notes TEXT
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_sources_enabled ON epg_sources(enabled, grab_capable)");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS epg_source_channels (
        source_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        xmltv_id TEXT NOT NULL,
        lang TEXT,
        site TEXT NOT NULL,
        site_id TEXT NOT NULL,
        PRIMARY KEY (source_key, name, xmltv_id, site, site_id)
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_source_channels_xmltv ON epg_source_channels(xmltv_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_source_channels_name ON epg_source_channels(name)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_source_channels_site ON epg_source_channels(site)");
  await db.execute(`
    INSERT OR IGNORE INTO epg_sources (key, provider, site, label, enabled, priority, grab_capable, imported_rows, last_sync_status, notes)
    SELECT
      'iptv-org:' || lower(site),
      'iptv-org',
      site,
      CASE WHEN lower(site) = 'epgshare01.online' THEN 'EPGShare 01' ELSE site END,
      1,
      CASE WHEN lower(site) = 'epgshare01.online' THEN 100 ELSE 0 END,
      1,
      COUNT(*),
      'migrated',
      CASE WHEN lower(site) = 'epgshare01.online' THEN 'Featured global grab-capable source' ELSE NULL END
    FROM iptv_org_map
    WHERE site IS NOT NULL AND site_id IS NOT NULL
    GROUP BY site
  `);
  await db.execute(`
    INSERT OR IGNORE INTO epg_source_channels (source_key, provider, name, xmltv_id, lang, site, site_id)
    SELECT 'iptv-org:' || lower(site), 'iptv-org', name, xmltv_id, lang, site, site_id
    FROM iptv_org_map
    WHERE site IS NOT NULL AND site_id IS NOT NULL
  `);
  await db.execute(`
    UPDATE epg_sources
    SET label = 'EPGShare 01',
        priority = 100,
        notes = COALESCE(NULLIF(notes, ''), 'Featured global grab-capable source')
    WHERE key = 'iptv-org:epgshare01.online'
  `);

  // Site status tracking for dynamic retry logic
  await db.execute(`
    CREATE TABLE IF NOT EXISTS site_status (
        site TEXT PRIMARY KEY,
        last_attempt INTEGER,
        last_success INTEGER,
        failure_count INTEGER DEFAULT 0
    )
  `);

  // Log of each individual channel grab attempt
  await db.execute(`
    CREATE TABLE IF NOT EXISTS grab_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        xmltv_id TEXT,
        site TEXT,
        timestamp INTEGER,
        success INTEGER,
        message TEXT,
        program_count INTEGER,
        duration_ms INTEGER
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_grab_logs_xmltv ON grab_logs(xmltv_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_grab_logs_timestamp ON grab_logs(timestamp)");

  // TMDb metadata cache - show level
  await db.execute(`
    CREATE TABLE IF NOT EXISTS metadata_cache (
        title_normalized TEXT PRIMARY KEY,
        tmdb_id INTEGER,
        tmdb_type TEXT,
        name TEXT,
        overview TEXT,
        poster_path TEXT,
        first_air_date TEXT,
        genres TEXT,
        rating REAL,
        last_updated INTEGER
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_metadata_cache_tmdb ON metadata_cache(tmdb_id)");

  // TMDb metadata cache - episode level
  await db.execute(`
    CREATE TABLE IF NOT EXISTS episode_metadata_cache (
        tmdb_id INTEGER,
        season_number INTEGER,
        episode_number INTEGER,
        name TEXT,
        overview TEXT,
        air_date TEXT,
        still_path TEXT,
        last_updated INTEGER,
        PRIMARY KEY (tmdb_id, season_number, episode_number)
    )
  `);

  // Add enrichment columns to epg_programs if not present
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN tmdb_id INTEGER"); } catch (e) { }
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN tmdb_poster TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN enriched INTEGER DEFAULT 0"); } catch (e) { }

  // Channel grab status tracking for auto-disable functionality
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channel_grab_status (
        xmltv_id TEXT PRIMARY KEY,
        consecutive_failures INTEGER DEFAULT 0,
        last_success INTEGER,
        last_failure INTEGER,
        auto_disabled INTEGER DEFAULT 0
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_channel_grab_status_disabled ON channel_grab_status(auto_disabled)");

  // Channel-site performance tracking for source preferences and grab failovers
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channel_site_status (
        xmltv_id TEXT,
        site TEXT,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        last_program_count INTEGER DEFAULT 0,
        last_attempt INTEGER,
        PRIMARY KEY (xmltv_id, site)
    )
  `);

  // TVMaze metadata cache (also created by metadata service, but needed for stats endpoint)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tvmaze_cache (
        title_normalized TEXT PRIMARY KEY,
        tvmaze_id INTEGER,
        genres TEXT,
        rating TEXT,
        cached_at INTEGER
    )
  `);

  // DVR scheduled recordings
  await db.execute(`
    CREATE TABLE IF NOT EXISTS scheduled_recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        program_title TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        stream_url TEXT NOT NULL,
        status TEXT DEFAULT 'scheduled',
        filename TEXT,
        file_size INTEGER,
        error_message TEXT,
        thumbnail TEXT,
        sub_title TEXT,
        episode_num TEXT,
        description TEXT,
        rating TEXT,
        category TEXT,
        created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  try { await db.execute("ALTER TABLE scheduled_recordings ADD COLUMN thumbnail TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE scheduled_recordings ADD COLUMN sub_title TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE scheduled_recordings ADD COLUMN episode_num TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE scheduled_recordings ADD COLUMN description TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE scheduled_recordings ADD COLUMN rating TEXT"); } catch (e) { }
  try { await db.execute("ALTER TABLE scheduled_recordings ADD COLUMN category TEXT"); } catch (e) { }
  await db.execute("CREATE INDEX IF NOT EXISTS idx_scheduled_recordings_status ON scheduled_recordings(status)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_scheduled_recordings_start ON scheduled_recordings(start_time)");

  // Manual metadata overrides – user-corrected TVMaze matches
  await db.execute(`
    CREATE TABLE IF NOT EXISTS metadata_overrides (
        title_normalized TEXT PRIMARY KEY,
        tvmaze_id INTEGER,
        show_name TEXT,
        genres TEXT,
        rating TEXT
    )
  `);

  // Channel favorites - user-marked channels for quick access
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channel_favorites (
      channel_id TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Hidden channels - user-hidden channels from UI
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channel_hidden (
      channel_id TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Persistent sync job history table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      cancel_requested INTEGER DEFAULT 0,
      start_time INTEGER,
      end_time INTEGER,
      stats_json TEXT,
      progress_json TEXT,
      error_message TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_sync_jobs_start ON sync_jobs(start_time)");

  // Clean up any stale/running jobs interrupted by server reboot
  try {
    const now = Date.now();
    await db.execute({
      sql: `UPDATE sync_jobs 
            SET status = 'interrupted', end_time = ?, error_message = 'Interrupted by server restart' 
            WHERE status = 'running'`,
      args: [now]
    });
  } catch (e) {
    console.error("Failed to clean up interrupted sync jobs on startup:", e);
  }

  // Apply failure count decay on boot to preserve failure history while allowing temporary failures to recover
  try {
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    // Decrease failure counts by 1 for records older than 24 hours
    await db.execute({
      sql: `UPDATE channel_grab_status 
            SET consecutive_failures = MAX(0, consecutive_failures - 1)
            WHERE last_failure IS NULL OR last_failure < ?`,
      args: [dayAgo]
    });

    // Re-enable channels whose failure count dropped below 5
    await db.execute(`
      UPDATE channel_grab_status SET auto_disabled = 0 WHERE consecutive_failures < 5 AND auto_disabled = 1
    `);
    await db.execute(`
      UPDATE channels SET enabled = 1 WHERE matched_epg_id IN (
        SELECT xmltv_id FROM channel_grab_status WHERE auto_disabled = 0
      ) AND enabled = 0
    `);

    // Clean up site_status failure counts older than 24 hours (decay failure count by 1)
    await db.execute({
      sql: `UPDATE site_status 
            SET failure_count = MAX(0, failure_count - 1)
            WHERE last_attempt IS NULL OR last_attempt < ?`,
      args: [dayAgo]
    });
  } catch (e) {
    console.error("Failed to apply failure count decay at startup:", e);
  }

  // File system cleanup
  await cleanupFileSystemOnBoot();

  // SQLite Optimization
  try {
    console.log("[Db] Running SQLite optimization (VACUUM & ANALYZE)...");
    await db.execute("VACUUM;");
    await db.execute("ANALYZE;");
    console.log("[Db] Database optimization complete.");
  } catch (e) {
    console.error("Failed to optimize database at startup:", e);
  }
}

async function cleanupFileSystemOnBoot() {
  try {
    const streamsDir = path.join(DB_DIR, 'streams');
    if (fs.existsSync(streamsDir)) {
      console.log("[BootCleanup] Purging stale stream directories...");
      const items = fs.readdirSync(streamsDir);
      for (const item of items) {
        const itemPath = path.join(streamsDir, item);
        try {
          fs.rmSync(itemPath, { recursive: true, force: true });
        } catch (err: any) {
          console.error(`[BootCleanup] Failed to remove ${itemPath}:`, err.message);
        }
      }
    }

    const cacheDir = path.join(DB_DIR, 'http-cache');
    if (fs.existsSync(cacheDir)) {
      console.log("[BootCleanup] Evicting expired cache files (older than 7 days)...");
      const files = fs.readdirSync(cacheDir);
      const now = Date.now();
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
      let deletedCount = 0;
      for (const file of files) {
        if (!file.endsWith('.bin')) continue;
        const filePath = path.join(cacheDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        } catch (err: any) {
          console.error(`[BootCleanup] Failed to process cache file ${filePath}:`, err.message);
        }
      }
      if (deletedCount > 0) {
        console.log(`[BootCleanup] Evicted ${deletedCount} expired cache files.`);
      }
    }
  } catch (err: any) {
    console.error("[BootCleanup] Error running boot filesystem cleanup:", err.message);
  }
}

export async function getSetting(key: string): Promise<string | null> {
  const result = await db.execute({ sql: "SELECT value FROM settings WHERE key = ?", args: [key] });
  return result.rows.length > 0 ? String(result.rows[0].value) : null;
}

export async function setSetting(key: string, value: string) {
  await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: [key, value] });
}
