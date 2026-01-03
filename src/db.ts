import { createClient } from "@libsql/client";
import * as fs from 'fs';
import * as path from 'path';

// Ensure data dir exists
export const DB_DIR = process.env.DB_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

export const db = createClient({
  url: `file:${DB_DIR}/local.db`,
});

export async function initDb() {
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

  try { await db.execute("ALTER TABLE channels ADD COLUMN lang TEXT"); } catch (e) {}
  try { await db.execute("ALTER TABLE channels ADD COLUMN match_type TEXT"); } catch (e) {}
  try { await db.execute("ALTER TABLE channels ADD COLUMN enabled INTEGER DEFAULT 1"); } catch (e) {}
  try { await db.execute("ALTER TABLE channels ADD COLUMN channel_number INTEGER"); } catch (e) {}

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
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN sub_title TEXT"); } catch (e) {}
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN episode_num TEXT"); } catch (e) {}
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN category TEXT"); } catch (e) {}
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN rating TEXT"); } catch (e) {}
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN icon TEXT"); } catch (e) {}
  
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_programs_channel ON epg_programs(channel_id, source)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_epg_programs_times ON epg_programs(start, stop)");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS manual_overrides (
        channel_id TEXT PRIMARY KEY,
        epg_id TEXT
    )
  `);

    // Drops and Recreates for updated schema
    await db.execute("DROP TABLE IF EXISTS iptv_org_map");

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
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN tmdb_id INTEGER"); } catch (e) {}
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN tmdb_poster TEXT"); } catch (e) {}
  try { await db.execute("ALTER TABLE epg_programs ADD COLUMN enriched INTEGER DEFAULT 0"); } catch (e) {}

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
}

export async function getSetting(key: string): Promise<string | null> {
    const result = await db.execute({ sql: "SELECT value FROM settings WHERE key = ?", args: [key] });
    return result.rows.length > 0 ? String(result.rows[0].value) : null;
}

export async function setSetting(key: string, value: string) {
    await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", args: [key, value] });
}
