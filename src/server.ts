import './services/patch-axios';
import express from 'express';
import { initDb, db, DB_DIR, getSetting } from './db';
// Playlist service removed
import axios from 'axios';
import { parse } from 'iptv-playlist-parser';
// Playlist service removed
import { getEpgFiles, processEpg, matchChannelsToIptvOrg, generatePlaylistAndEpg, cleanupEpgData, invalidateIptvOrgCache } from './services/epg';
import { updateIptvOrgData } from './services/iptv-org';
import { grabMissingChannels, getAutoDisabledChannels, reEnableChannels } from './services/grabber';
import { updateIptvOrgPlaylists } from './services/iptv-org-playlists';
import { enrichProgramsWithMetadata, getEnrichmentStats, clearMetadataCache, isEnrichmentEnabled, refreshImdbData, searchTVMaze, searchTVMazeShows, normalizeTitle } from './services/metadata';
import { PipelineQueue } from './services/pipeline';
import { getJobStatus, startJob, completeJob, requestJobCancel } from './job';
import { eventBus, emitLog, emitProgress } from './events';
import { startRecordingScheduler, cancelRecording as cancelRec, getRecordingFilePath, checkScheduledRecordings, startRecording, stopRecording } from './recorder';
import { StreamManager } from './services/stream';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { tui } from './services/tui';
import { formatMemorySnapshot } from './services/memory';
import { buildPlaylistImportIndexes, createPlaylistChannelRecord, type PlaylistChannelRow } from './services/playlist-import';
import { describePlaylist } from './services/playlist-metadata';

function summarizePlaylistScope(items: Array<{ importedCount?: number; channelCountEstimate?: number | null }>) {
    const selectedCount = items.length;
    const importedChannels = items.reduce((sum, item) => sum + Number(item.importedCount || 0), 0);
    const estimatedChannels = items.reduce((sum, item) => sum + Number(item.channelCountEstimate || 0), 0);
    return { selectedCount, importedChannels, estimatedChannels };
}

import schedule from 'node-cron';

const app = express();
const PORT = parseInt(process.env.API_PORT || '4000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// In-memory auth token store
const validTokens = new Set<string>();

app.use(express.json());

// Backend runs purely as an API server

app.use('/files/streams/:id', (req, res, next) => {
    StreamManager.keepAlive(req.params.id);
    next();
});
app.use('/files', express.static(DB_DIR)); // Static files


// ── Auth endpoints ────────────────────────────

app.post('/api/auth', (req: any, res: any) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = crypto.randomUUID();
        validTokens.add(token);
        return res.json({ success: true, token });
    }
    res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/auth/status', (req: any, res: any) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        if (validTokens.has(token)) {
            return res.json({ authenticated: true });
        }
    }
    res.json({ authenticated: false, required: true });
});

app.post('/api/auth/logout', (req: any, res: any) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        validTokens.delete(authHeader.slice(7));
    }
    res.json({ success: true });
});

// ── Auth middleware for admin routes ──────────
function requireAuth(req: any, res: any, next: any) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        if (validTokens.has(token)) {
            return next();
        }
    }
    res.status(401).json({ error: 'Authentication required. Please log in at /admin/' });
}

export let activePipeline: PipelineQueue | null = null;

/**
 * Perform a full automation cycle:
 * 1. Refresh playlist from source
 * 2. Download and parse selected EPG sources
 * 3. Update IPTV-ORG metadata and match channels
 * 4. Custom grab missing guide data
 * 5. Generate final M3U and XML files
 */
export async function runFullSync() {
    const status = getJobStatus();
    if (status.running) {
        emitLog("Sync already in progress, skipping...", "warning");
        return;
    }

    startJob();
    try {
        if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");
        emitLog("Starting full automation cycle...", "info");

        // Refresh iptv-org playlists first to make sure any imported local iptv-org playlists have fresh URLs
        try {
            emitLog("Updating local iptv-org playlists...", "info");
            await updateIptvOrgPlaylists();
        } catch (e: any) {
            emitLog(`Failed to update iptv-org playlists: ${e.message}`, "warning");
        }

        // 1. Refresh Playlists (multi-playlist support)
        const plUrlsResult = await db.execute("SELECT value FROM settings WHERE key = 'playlist_urls'");
        const plSingleResult = await db.execute("SELECT value FROM settings WHERE key = 'playlist_url'");

        let playlistUrls: string[] = [];
        if (plUrlsResult.rows.length > 0) {
            try {
                playlistUrls = JSON.parse(String(plUrlsResult.rows[0].value));
            } catch { playlistUrls = []; }
        }
        // Fallback to single playlist_url if no array found
        if (playlistUrls.length === 0 && plSingleResult.rows.length > 0) {
            playlistUrls = [String(plSingleResult.rows[0].value)];
        }

        if (playlistUrls.length > 0) {
            emitLog(`Refreshing ${playlistUrls.length} playlist(s)...`, "info");
            for (const url of playlistUrls) {
                if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");
                try {
                    emitLog(`Loading playlist: ${url}`, "info");
                    await updatePlaylist(url);
                } catch (e: any) {
                    emitLog(`Failed to load playlist ${url}: ${e.message}`, "error");
                }
            }
        } else {
            emitLog("No playlist configured.", "warning");
        }

        if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");
        // 2. Update IPTV-ORG Metadata & Match — stream newly matched IDs into the grabber
        //    as matching progresses, so EPG grabs start immediately rather than waiting
        //    for all 1,000+ channels to finish matching first.
        emitLog("Updating IPTV-ORG metadata and matching channels...", "info");
        await updateIptvOrgData();
        invalidateIptvOrgCache(); // matching cache now stale — will reload on next matchChannelsToIptvOrg call

        if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");
        const daysResult = await db.execute("SELECT value FROM settings WHERE key = 'epg_days'");
        const epgDays = daysResult.rows.length > 0 ? String(daysResult.rows[0].value) : '2';

        // Initialize our streaming pipeline queue
        const pipeline = new PipelineQueue(epgDays);
        activePipeline = pipeline;

        const enqueuePromises: Promise<void>[] = [];
        const matchedCount = await matchChannelsToIptvOrg((newIds) => {
            if (newIds.length === 0) return;
            emitLog(`[Pipeline] Queuing batch of ${newIds.length} newly matched channels for EPG grab...`, "info");
            enqueuePromises.push(pipeline.enqueueMatched(newIds));
        });
        await Promise.all(enqueuePromises);
        emitLog(`Matching complete. Total matched: ${matchedCount}`, "success");

        // 3. Also grab any channels that were already matched before this run
        const alreadyMatched = await db.execute(`
            SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id) as xmltv_id
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            WHERE (c.matched_epg_id IS NOT NULL OR mo.epg_id IS NOT NULL)
            AND c.enabled = 1
        `);
        const allIds = alreadyMatched.rows.map(r => String(r.xmltv_id)).filter(Boolean);

        // Let the pipeline queue process everything that was already matched
        await pipeline.enqueueMatched(allIds);

        // Tell the pipeline no more matches are coming
        pipeline.setMatchingComplete(matchedCount, matchedCount);

        // Wait for all grab batches (streaming + full pass) AND enrichment to finish
        emitLog(`Waiting for background EPG grabs and metadata enrichment to finish...`, "info");
        await pipeline.waitForCompletion();

        if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");

        // 4. (Enrichment is now handled concurrently by the streaming pipeline)
        let enrichmentStats = null;
        if (await isEnrichmentEnabled()) {
            // PipelineQueue handles it, get global stats to emit
            enrichmentStats = await getEnrichmentStats();
        }

        // 5. Cleanup and Generate Final Files
        await cleanupEpgData();
        emitLog("Generating final M3U and XML files...", "info");
        const result = await generatePlaylistAndEpg();

        // 6. Complete
        const totalChannels = await db.execute("SELECT COUNT(*) as c FROM channels");
        const stats: any = {
            channelsProcessed: result.epgChannels,
            programsProcessed: result.epgPrograms,
            channelsMatched: result.playlistCount,
            totalChannels: Number(totalChannels.rows[0].c),
            filesGenerated: ['playlist.m3u', 'epg.xml'],
            customGrabCount: allIds.length
        };
        if (enrichmentStats) {
            stats.enrichment = enrichmentStats;
        }
        completeJob(stats);
        eventBus.emit('report', stats);
        emitLog(`Automation cycle complete! ${result.playlistCount} channels matched and exported.`, "success");

    } catch (e: any) {
        emitLog(`Automation failed: ${e.message} `, "error");
        console.error("Full sync error:", e);
        completeJob(null);
    } finally {
        activePipeline = null;
    }
}


// Automation Cycle (Every day at 02:00 and 14:00)
schedule.schedule('0 2,14 * * *', async () => {
    emitLog("Running scheduled automation cycle (every 12 hours)...", "info");
    runFullSync().catch(e => console.error("Scheduled full sync failed:", e));
});

app.get('/api/settings', requireAuth, async (req: any, res: any) => {
    try {
        const result = await db.execute("SELECT * FROM settings");
        const settings: any = {};
        for (const row of result.rows) {
            settings[row.key as string] = row.value;
        }
        // Legacy field ignored
        settings.epg_urls = [];
        res.json(settings);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/channels-with-programs - Returns channels with current/next program info
app.get('/api/channels-with-programs', requireAuth, async (req: any, res: any) => {
    try {
        const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14) + '00 +0000';

        const result = await db.execute(`
SELECT
c.*,
    COALESCE(mo.epg_id, c.matched_epg_id) as effective_epg_id,
    MAX(p.title) as current_program_title,
    MAX(p.sub_title) as current_program_subtitle,
    MAX(p.episode_num) as current_program_episode,
    MAX(p.icon) as current_program_icon,
    MAX(p.start) as current_program_start,
    MAX(p.stop) as current_program_stop,
    MAX(p.category) as current_program_category
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            LEFT JOIN epg_programs p ON COALESCE(mo.epg_id, c.matched_epg_id) = p.channel_id
                AND p.start <= '${now}' AND p.stop > '${now}'
            GROUP BY c.id
            ORDER BY c.channel_number, c.name
    `);

        res.json(result.rows);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/job-status', (req, res) => {
    res.json({
        ...getJobStatus(),
        daily: 'Every 12 hours (02:00, 14:00)',
        weekly: 'Disabled'
    });
});

// Playlist endpoints removed

app.get('/api/epg-files', requireAuth, async (req: any, res: any) => {
    try {
        const files = await getEpgFiles();
        res.json(files);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/grab-logs', requireAuth, async (req: any, res: any) => {
    try {
        const result = await db.execute("SELECT * FROM grab_logs ORDER BY timestamp DESC LIMIT 1000");
        res.json(result.rows);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});


app.get('/api/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const onLog = (log: any) => sendEvent('log', log);
    const onProgress = (prog: any) => sendEvent('progress', prog);
    const onReport = (report: any) => sendEvent('report', report);

    eventBus.on('log', onLog);
    eventBus.on('progress', onProgress);
    eventBus.on('report', onReport);

    req.on('close', () => {
        eventBus.off('log', onLog);
        eventBus.off('progress', onProgress);
        eventBus.off('report', onReport);
    });
});

app.post('/api/select-epg', requireAuth, async (req: any, res: any) => {
    // Legacy endpoint, now triggers full sync
    runFullSync().catch(e => console.error("API triggered sync failed:", e));
    res.json({ success: true, message: "Sync started in background." });
});

// POST /api/sync/cancel - Cancel any running sync process
app.post('/api/sync/cancel', requireAuth, async (req: any, res: any) => {
    const status = getJobStatus();
    if (!status.running) {
        return res.json({ success: false, message: "No sync job is currently running." });
    }
    emitLog("Sync cancellation requested by user...", "warning");
    requestJobCancel();
    if (activePipeline) {
        activePipeline.cancel();
    } else {
        // Fallback for non-pipeline background grabs
        import('./services/grabber.js').then(({ cancelAllGrabProcesses }) => {
            cancelAllGrabProcesses();
        }).catch(err => console.error("Error calling cancelAllGrabProcesses:", err));
    }
    res.json({ success: true, message: "Sync cancellation initiated." });
});

// POST /api/sync - Clean alias for full pipeline trigger
app.post('/api/sync', requireAuth, async (req: any, res: any) => {
    const status = getJobStatus();
    if (status.running) {
        return res.json({ success: false, message: "Sync already in progress." });
    }
    runFullSync().catch(e => console.error("API /api/sync triggered sync failed:", e));
    res.json({ success: true, message: "Full sync started in background." });
});

// POST /api/sync-playlist - Reload playlist only (no match/grab/enrich) — runs in background
app.post('/api/sync-playlist', requireAuth, async (req: any, res: any) => {
    try {
        const plResult = await db.execute("SELECT value FROM settings WHERE key = 'playlist_url'");
        if (plResult.rows.length === 0) {
            return res.status(400).json({ error: "No playlist URL configured." });
        }
        const url = String(plResult.rows[0].value);
        // Fire in background — return immediately so the client doesn't wait on network I/O
        (async () => {
            try {
                emitLog(`Reloading playlist from: ${url}`, "info");
                const count = await updatePlaylist(url);
                emitLog(`Playlist reloaded: ${count} channels imported.`, "success");
                emitProgress("Playlist reload complete", 100, 100, 'match');
            } catch (e: any) {
                emitLog(`Playlist reload failed: ${e.message}`, "error");
            }
        })();
        res.json({ success: true, message: "Playlist reload started in background." });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/grab', requireAuth, async (req: any, res: any) => {
    try {
        // Trigger grab for all pre-matched channels that are currently missing guide data
        const missing = await db.execute(`
            SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id) as xmltv_id 
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            LEFT JOIN epg_programs p ON COALESCE(mo.epg_id, c.matched_epg_id) = p.channel_id
WHERE(c.matched_epg_id IS NOT NULL OR mo.epg_id IS NOT NULL)
            AND p.channel_id IS NULL
            AND c.enabled = 1
    `);
        const ids = missing.rows.map(r => String(r.xmltv_id));
        if (ids.length === 0) {
            return res.json({ success: true, message: "No missing guide data found for matched channels." });
        }

        // Run in background but return success that it started
        grabMissingChannels(ids, true).catch(err => {
            console.error("Grab failed:", err);
            emitLog(`Grab failed: ${err.message} `, "error");
        });
        res.json({ success: true, count: ids.length });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/rebuild-files', requireAuth, async (req: any, res: any) => {
    try {
        await cleanupEpgData();
        const result = await generatePlaylistAndEpg();
        res.json({ success: true, stats: result });
    } catch (e: any) {
        console.error("Manual rebuild failed:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/reset', requireAuth, async (req: any, res: any) => {
    try {
        emitLog("Initiating full system reset...", "warning");

        // ── 1. Clear all DB tables (channels, programs, guide data, playlists, etc.) ──
        const tables = [
            'settings', 'channels', 'epg_channels', 'epg_programs',
            'manual_overrides', 'iptv_org_map', 'site_status', 'grab_logs',
            'metadata_cache', 'episode_metadata_cache', 'channel_grab_status',
            'tvmaze_cache', 'scheduled_recordings', 'metadata_overrides',
            'channel_favorites', 'channel_hidden'
        ];
        for (const table of tables) {
            try { await db.execute(`DELETE FROM ${table}`); } catch (_) { /* table may not exist */ }
        }
        emitLog("Database tables cleared.", "info");

        // ── 2. Delete the SQLite DB file + WAL/SHM so no stale data persists ──
        //    (We must close the connection first by calling VACUUM to force a checkpoint)
        try { await db.execute("VACUUM"); } catch (_) { }
        const dbFile = path.join(DB_DIR, 'local.db');
        const dbWal  = path.join(DB_DIR, 'local.db-wal');
        const dbShm  = path.join(DB_DIR, 'local.db-shm');
        for (const f of [dbFile, dbWal, dbShm]) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        emitLog("SQLite database file deleted.", "info");

        // Re-initialise fresh schema
        fs.writeFileSync(dbFile, '');
        await initDb();
        emitLog("Fresh database schema created.", "info");

        // ── 3. Remove generated output files ──
        for (const name of ['playlist.m3u', 'epg.xml']) {
            const p = path.join(DB_DIR, name);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        // ── 4. Remove downloaded guide source / playlist caches ──
        //    These are re-downloaded on the next sync.
        const cacheDirs = ['iptv-org-epg', 'iptv-org-playlists', 'imdb-data'];
        for (const dir of cacheDirs) {
            const p = path.join(DB_DIR, dir);
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                emitLog(`Removed cached data: ${dir}`, "info");
            }
        }

        // ── 5. Remove streams and recordings ──
        for (const dir of ['streams', 'recordings']) {
            const p = path.join(DB_DIR, dir);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }

        emitLog("Full system reset complete. All channels, playlists, guide data, and program data cleared.", "success");
        res.json({ success: true });
    } catch (e: any) {
        console.error("Full reset failed:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/playlist.m3u', async (req, res) => {
    // Generate fresh or serve from file?
    // Requirement "export an m3u file ... resulting from selections".
    // Let's generate it on demand or on save?
    // User asked to "persist ... playlist.m3u".
    // Let's generate it here but also save it during processEpg?
    // Actually, processEpg modifies channels. 
    // Let's generate it dynamically for now but maybe save?
    // Wait, requirement: "rebuilds should be on a schedule... build once and then serve".
    // So we should generate the M3U at the end of processEpg too.

    const m3uPath = path.join(DB_DIR, 'playlist.m3u');
    if (fs.existsSync(m3uPath)) {
        res.header('Content-Type', 'audio/x-mpegurl');
        res.sendFile(m3uPath);
    } else {
        res.status(404).send("Not generated yet");
    }
});

app.get('/epg.xml', async (req, res) => {
    const epgPath = path.join(DB_DIR, 'epg.xml');
    if (fs.existsSync(epgPath)) {
        res.header('Content-Type', 'text/xml');
        res.sendFile(epgPath);
    } else {
        res.status(404).send("Not generated yet");
    }
});

async function startServer() {
    emitLog("Initializing database...", "info");
    await initDb();

    // Initialize TUI
    tui.init();

    // Catch-all 404 for unhandled API/File requests
    app.use((req: express.Request, res: express.Response) => {
        res.status(404).json({ error: 'Not found' });
    });

    app.listen(PORT, () => {
        emitLog(`Server running on port ${PORT} `, "success");
    });

    // Start DVR recording scheduler
    startRecordingScheduler();

    emitLog("Server ready. Waiting for user-triggered sync.", "info");
}

startServer().catch(err => {
    console.error("Critical server failure:", err);
    process.exit(1);
});

// Graceful shutdown handlers
function shutdown(): void {
    process.exit(0);
}

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    shutdown();
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    shutdown();
});

// GET /api/config - Unified config
app.get('/api/config', requireAuth, async (req: any, res: any) => {
    try {
        const settingsRes = await db.execute("SELECT * FROM settings");
        const config: any = {};
        for (const row of settingsRes.rows) {
            if (row.key === 'epg_urls') {
                config.epg_urls = [];
            } else if (row.key === 'playlist_urls') {
                // Parse JSON array for the client
                try {
                    config.playlist_urls = JSON.parse(String(row.value));
                } catch {
                    config.playlist_urls = [];
                }
            } else {
                config[row.key as string] = row.value;
            }
        }
        // Ensure playlist_urls is always an array
        if (!config.playlist_urls) config.playlist_urls = [];
        res.json(config);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/config - Save config & Trigger actions
app.post('/api/config', requireAuth, async (req: any, res: any) => {
    try {
        const { playlist_url, playlist_urls, epg_urls, preferred_lang, epg_days } = req.body;

        // Get current playlist url to see if it changed
        const currentRes = await db.execute("SELECT value FROM settings WHERE key = 'playlist_url'");
        const currentUrl = currentRes.rows.length > 0 ? currentRes.rows[0].value : null;

        // Playlist URLs management
        if (playlist_urls && Array.isArray(playlist_urls)) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_urls', ?)",
                args: [JSON.stringify(playlist_urls)]
            });
            // Set playlist_url to first entry for backward compatibility
            if (playlist_urls.length > 0) {
                await db.execute({
                    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_url', ?)",
                    args: [playlist_urls[0]]
                });
            }
        }

        if (playlist_url && !(playlist_urls && Array.isArray(playlist_urls))) {
            // Legacy: single playlist_url provided without playlist_urls array
            const currentUrlsStr = await getSetting('playlist_urls');
            let urls: string[] = [];
            try { urls = currentUrlsStr ? JSON.parse(currentUrlsStr) : []; } catch (_) { }

            if (!urls.includes(playlist_url)) {
                urls.push(playlist_url);
                await db.execute({
                    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_urls', ?)",
                    args: [JSON.stringify(urls)]
                });
            }

            await db.execute({
                sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_url', ?)",
                args: [playlist_url]
            });
        }

        // Legacy epg_urls ignored

        if (preferred_lang !== undefined) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('preferred_lang', ?)",
                args: [preferred_lang]
            });
        }

        if (epg_days !== undefined) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('epg_days', ?)",
                args: [String(epg_days)]
            });
        }

        res.json({ success: true });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/mapping - Get all current channels and their match status
app.get('/api/mapping', requireAuth, async (req: any, res: any) => {
    try {
        // Get all channels and their manual overrides
        const channelsRes = await db.execute(`
SELECT
c.*,
    mo.epg_id as override_epg_id,
    CASE WHEN mo.epg_id IS NOT NULL THEN 1 ELSE 0 END as is_overridden
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            ORDER BY c.match_type DESC, c.name ASC
    `);

        // To get current program, we need to compare with current time
        // EPG format: 20231223120000 +0000
        const now = new Date();
        const nowStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 14) + " +0000";

        // Optimization: Get current programs for all matched channels
        // We'll do this in a second query to avoid a massive join that might be slow
        const programsRes = await db.execute({
            sql: `
                SELECT channel_id, title 
                FROM epg_programs 
                WHERE start <= ? AND stop > ?
    `,
            args: [nowStr, nowStr]
        });

        const progMap = new Map();
        for (const p of programsRes.rows) {
            progMap.set(String(p.channel_id), String(p.title));
        }

        // Also get icons from epg_channels if missing in channel
        const epgIconsRes = await db.execute("SELECT id, icon FROM epg_channels");
        const iconMap = new Map();
        for (const r of epgIconsRes.rows) {
            if (r.icon) iconMap.set(String(r.id), String(r.icon));
        }

        // GET LATEST GRAB STATUS
        const grabLogsRes = await db.execute(`
                SELECT xmltv_id, success, message, timestamp 
                FROM grab_logs 
                WHERE id IN(SELECT MAX(id) FROM grab_logs GROUP BY xmltv_id)
            `);
        const statusMap = new Map();
        for (const r of grabLogsRes.rows) {
            statusMap.set(String(r.xmltv_id), {
                success: Boolean(r.success),
                message: String(r.message),
                timestamp: Number(r.timestamp)
            });
        }

        const rows = channelsRes.rows.map(row => {
            const matchedId = (row.is_overridden ? row.override_epg_id : row.matched_epg_id) as string;
            return {
                ...row,
                current_program: matchedId ? (progMap.get(matchedId) || 'No Program Data') : null,
                epg_icon: matchedId ? iconMap.get(matchedId) : null,
                last_grab: matchedId ? statusMap.get(matchedId) : null
            };
        });

        res.json(rows);
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/override - Save a manual override
app.post('/api/override', requireAuth, async (req: any, res: any) => {
    try {
        const { channel_id, epg_id } = req.body;
        if (!channel_id) throw new Error("Missing channel_id");

        if (epg_id) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO manual_overrides (channel_id, epg_id) VALUES (?, ?)",
                args: [channel_id, epg_id]
            });
            // Immediately grab EPG data for the newly matched channel in the background.
            // This avoids having to wait for the next full sync.
            (async () => {
                try {
                    emitLog(`Grabbing EPG for newly matched channel: ${epg_id}`, "info");
                    await grabMissingChannels([String(epg_id)], true);
                    emitLog(`EPG grab complete for: ${epg_id}`, "success");
                } catch (e: any) {
                    emitLog(`EPG grab failed for ${epg_id}: ${e.message}`, "error");
                }
            })();
        } else {
            // Clear override — reset to auto-matched (or unmatched)
            await db.execute({
                sql: "DELETE FROM manual_overrides WHERE channel_id = ?",
                args: [channel_id]
            });
        }
        res.json({ success: true });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/channels/toggle - Enable/Disable channels (supports bulk)
app.post('/api/channels/toggle', requireAuth, async (req: any, res: any) => {
    try {
        const { ids, enabled } = req.body;
        if (!ids || !Array.isArray(ids)) throw new Error("Missing or invalid ids array");

        const newStatus = enabled ? 1 : 0;
        const placeholders = ids.map(() => "?").join(",");

        await db.execute({
            sql: `UPDATE channels SET enabled = ? WHERE id IN(${placeholders})`,
            args: [newStatus, ...ids]
        });

        if (newStatus === 1) {
            // Check if any of these newly enabled channels need guide data
            const missing = await db.execute({
                sql: `
                    SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id) as xmltv_id 
                    FROM channels c
                    LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
                    LEFT JOIN epg_programs p ON COALESCE(mo.epg_id, c.matched_epg_id) = p.channel_id
                    WHERE c.id IN (${placeholders})
                    AND (c.matched_epg_id IS NOT NULL OR mo.epg_id IS NOT NULL)
                    AND p.channel_id IS NULL
                `,
                args: [...ids]
            });
            const grabIds = missing.rows.map(r => String(r.xmltv_id));
            if (grabIds.length > 0) {
                grabMissingChannels(grabIds, true).catch(err => {
                    console.error("Grab on toggle failed:", err);
                });
            }
        }

        res.json({ success: true });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/channels - Get all channels (lightweight list for admin UI)
app.get('/api/channels', requireAuth, async (req: any, res: any) => {
    try {
        const result = await db.execute(`
            SELECT 
                c.*,
                mo.epg_id as override_epg_id,
                CASE WHEN mo.epg_id IS NOT NULL THEN 1 ELSE 0 END as is_overridden
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            ORDER BY c.channel_number, c.name
        `);
        res.json(result.rows);
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/channels/:id - Update a channel's settings
app.put('/api/channels/:id', requireAuth, async (req: any, res: any) => {
    try {
        const channelId = req.params.id;
        const { name, url, tvg_id, tvg_logo, group_title, channel_number, enabled } = req.body;

        const updates: string[] = [];
        const args: any[] = [];

        if (name !== undefined) { updates.push("name = ?"); args.push(name); }
        if (url !== undefined) { updates.push("url = ?"); args.push(url); }
        if (tvg_id !== undefined) { updates.push("tvg_id = ?"); args.push(tvg_id); }
        if (tvg_logo !== undefined) { updates.push("tvg_logo = ?"); args.push(tvg_logo); }
        if (group_title !== undefined) { updates.push("group_title = ?"); args.push(group_title); }
        if (channel_number !== undefined) { updates.push("channel_number = ?"); args.push(channel_number); }
        if (enabled !== undefined) { updates.push("enabled = ?"); args.push(enabled ? 1 : 0); }

        if (updates.length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        args.push(channelId);
        await db.execute({
            sql: `UPDATE channels SET ${updates.join(", ")} WHERE id = ?`,
            args
        });

        res.json({ success: true });
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/channels/favorites - Get all favorite channel IDs
app.get('/api/channels/favorites', async (req, res) => {
    try {
        const result = await db.execute("SELECT channel_id, created_at FROM channel_favorites ORDER BY created_at DESC");
        res.json(result.rows.map(r => r.channel_id));
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/channels/favorites - Add channel to favorites
app.post('/api/channels/favorites', requireAuth, async (req: any, res: any) => {
    try {
        const { channel_id } = req.body;
        if (!channel_id) {
            return res.status(400).json({ error: "Missing channel_id" });
        }
        await db.execute({
            sql: "INSERT OR REPLACE INTO channel_favorites (channel_id) VALUES (?)",
            args: [channel_id]
        });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/channels/favorites/:id - Remove channel from favorites
app.delete('/api/channels/favorites/:id', requireAuth, async (req: any, res: any) => {
    try {
        const channelId = req.params.id;
        await db.execute({
            sql: "DELETE FROM channel_favorites WHERE channel_id = ?",
            args: [channelId]
        });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/channels/hidden - Get all hidden channel IDs
app.get('/api/channels/hidden', async (req, res) => {
    try {
        const result = await db.execute("SELECT channel_id, created_at FROM channel_hidden ORDER BY created_at DESC");
        res.json(result.rows.map(r => r.channel_id));
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/channels/hidden - Hide a channel
app.post('/api/channels/hidden', requireAuth, async (req: any, res: any) => {
    try {
        const { channel_id } = req.body;
        if (!channel_id) {
            return res.status(400).json({ error: "Missing channel_id" });
        }
        await db.execute({
            sql: "INSERT OR REPLACE INTO channel_hidden (channel_id) VALUES (?)",
            args: [channel_id]
        });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/channels/hidden/:id - Unhide a channel
app.delete('/api/channels/hidden/:id', requireAuth, async (req: any, res: any) => {
    try {
        const channelId = req.params.id;
        await db.execute({
            sql: "DELETE FROM channel_hidden WHERE channel_id = ?",
            args: [channelId]
        });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/iptv-org/playlists - List local iptv-org playlists
app.get('/api/iptv-org/playlists', requireAuth, async (req: any, res: any) => {
    try {
        const targetDir = path.join(DB_DIR, 'iptv-org-playlists');
        if (!fs.existsSync(targetDir)) {
            await updateIptvOrgPlaylists();
        }
        
        const playlists: any[] = [];
        const folders = ['countries', 'categories', 'languages', 'regions'];
        
        for (const folder of folders) {
            const folderPath = path.join(targetDir, folder);
            if (fs.existsSync(folderPath)) {
                const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.m3u'));
                files.forEach(f => {
                    const url = `/files/iptv-org-playlists/${folder}/${f}`;
                    const meta = describePlaylist(url);
                    playlists.push({
                        ...meta,
                        name: f.replace('.m3u', '').toUpperCase() + ` (${folder})`
                    });
                });
            }
        }
        res.json(playlists);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/iptv-org/update-playlists - Force update iptv-org playlists
app.post('/api/iptv-org/update-playlists', requireAuth, async (req: any, res: any) => {
    try {
        await updateIptvOrgPlaylists();
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/playlists - List all configured playlist URLs with channel counts
app.get('/api/playlists', requireAuth, async (req: any, res: any) => {
    try {
        const urlsStr = await getSetting('playlist_urls');
        const activeUrl = await getSetting('playlist_url');
        let urls: string[] = [];
        try { urls = urlsStr ? JSON.parse(urlsStr) : []; } catch (_) { }
        // If there's a single active URL not in the list, prepend it
        if (activeUrl && !urls.includes(activeUrl)) urls.unshift(activeUrl);

        // Get channel counts per source_url
        const counts = await db.execute('SELECT source_url, COUNT(*) as count FROM channels GROUP BY source_url');
        const countMap = new Map(counts.rows.map(r => [String(r.source_url), Number(r.count)]));
        const playlists = urls.map(url => ({
            ...describePlaylist(url, countMap.get(url) || 0),
            count: countMap.get(url) || 0,
            active: url === activeUrl
        }));

        res.json({
            items: playlists,
            summary: summarizePlaylistScope(playlists)
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/playlists - Add a new playlist URL and import channels
app.post('/api/playlists', requireAuth, async (req: any, res: any) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: "Missing playlist URL" });
        }

        // Validate URL format
        try {
            new URL(url);
        } catch (_) {
            return res.status(400).json({ error: "Invalid URL format" });
        }

        // Get current playlist URLs
        const urlsStr = await getSetting('playlist_urls');
        let urls: string[] = [];
        try { urls = urlsStr ? JSON.parse(urlsStr) : []; } catch (_) { }

        // Check if already exists
        if (urls.includes(url)) {
            return res.status(400).json({ error: "Playlist URL already exists" });
        }

        // Add to list
        urls.push(url);
        await db.execute({
            sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_urls', ?)",
            args: [JSON.stringify(urls)]
        });

        // Also set as active playlist_url if first one
        if (urls.length === 1) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_url', ?)",
                args: [url]
            });
        }

        // Import channels in background
        (async () => {
            try {
                emitLog(`Importing channels from new playlist: ${url}`, "info");
                const count = await updatePlaylist(url);
                emitLog(`Imported ${count} channels from ${url}`, "success");
            } catch (e: any) {
                emitLog(`Failed to import playlist ${url}: ${e.message}`, "error");
            }
        })();

        res.json({ success: true, message: "Playlist added, importing channels in background." });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/playlists - Remove a playlist URL
app.delete('/api/playlists', requireAuth, async (req: any, res: any) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: "Missing playlist URL" });
        }

        const urlStr = Array.isArray(url) ? url[0] : url;

        // Get current playlist URLs
        const urlsStr = await getSetting('playlist_urls');
        let urls: string[] = [];
        try { urls = urlsStr ? JSON.parse(urlsStr) : []; } catch (_) { }

        const index = urls.indexOf(urlStr);
        if (index === -1) {
            return res.status(404).json({ error: "Playlist URL not found" });
        }

        // Remove from list
        urls.splice(index, 1);
        await db.execute({
            sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_urls', ?)",
            args: [JSON.stringify(urls)]
        });

        // Delete channels from this source
        await db.execute({
            sql: "DELETE FROM channels WHERE source_url = ?",
            args: [urlStr]
        });

        // Clear active playlist if it was the removed one
        const activeUrl = await getSetting('playlist_url');
        if (activeUrl === urlStr) {
            const newActive = urls.length > 0 ? urls[0] : null;
            await db.execute({
                sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_url', ?)",
                args: [newActive]
            });
        }

        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ── DVR Endpoints ─────────────────────────────

app.get('/api/dvr', requireAuth, async (req: any, res: any) => {
    try {
        const result = await db.execute("SELECT * FROM scheduled_recordings ORDER BY start_time DESC");
        res.json(result.rows);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/dvr', requireAuth, async (req: any, res: any) => {
    try {
        const { channel_id, program_title, start_time, end_time, stream_url } = req.body;

        await db.execute({
            sql: `INSERT INTO scheduled_recordings (channel_id, program_title, start_time, end_time, stream_url, status)
                  VALUES (?, ?, ?, ?, ?, 'scheduled')`,
            args: [channel_id, program_title, start_time, end_time, stream_url]
        });

        // Check if we need to start it immediately (scheduler checks every 30s)
        checkScheduledRecordings();

        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/dvr/stop/:id', requireAuth, async (req: any, res: any) => {
    try {
        const id = parseInt(req.params.id);
        await stopRecording(id);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/dvr/:id', requireAuth, async (req: any, res: any) => {
    try {
        const id = parseInt(req.params.id);
        await cancelRec(id);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/dvr/storage - Recording storage usage
app.get('/api/dvr/storage', requireAuth, async (req: any, res: any) => {
    try {
        const recordingsDir = path.join(DB_DIR, 'recordings');
        let usedBytes = 0;
        if (fs.existsSync(recordingsDir)) {
            const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.mp4') || f.includes('.part'));
            for (const f of files) {
                try {
                    const stat = fs.statSync(path.join(recordingsDir, f));
                    usedBytes += stat.size;
                } catch (_) {}
            }
        }

        // Get filesystem info for the data directory
        const { execSync } = require('child_process');
        let totalBytes = 0;
        try {
            const df = execSync(`df -B1 "${DB_DIR}"`, { encoding: 'utf8' });
            const lines = df.trim().split('\n');
            if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                // total blocks, used, available, use%, mount
                totalBytes = parseInt(parts[1]) || 0;
            }
        } catch (_) {
            totalBytes = usedBytes > 0 ? usedBytes * 10 : 10 * 1024 * 1024 * 1024; // fallback
        }

        res.json({ usedBytes, totalBytes });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/recordings - List all recordings
app.get('/api/recordings', requireAuth, async (req: any, res: any) => {
    try {
        const recordingsDir = path.join(DB_DIR, 'recordings');
        
        if (!fs.existsSync(recordingsDir)) {
            return res.json([]);
        }
        
        const files = fs.readdirSync(recordingsDir)
            .filter(f => f.endsWith('.mp4'))
            .map(f => {
                const filePath = path.join(recordingsDir, f);
                const stats = fs.statSync(filePath);
                return {
                    filename: f,
                    size: stats.size,
                    created: stats.birthtime.toISOString(),
                    url: `/files/recordings/${f}`
                };
            })
            .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
        
        res.json(files);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /files/recordings/:filename - Serve recording files
app.get('/files/recordings/:filename', (req: any, res: any) => {
    const filename = req.params.filename;
    if (!filename.endsWith('.mp4')) {
        return res.status(400).json({ error: "Invalid file type" });
    }
    
    const filePath = path.join(DB_DIR, 'recordings', filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Recording not found" });
    }
    
    res.header('Content-Type', 'video/mp4');
    res.header('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(filePath);
});

// DELETE /api/recordings/:filename - Delete a recording
app.delete('/api/recordings/:filename', requireAuth, async (req: any, res: any) => {
    try {
        const filename = req.params.filename;
        if (!filename.endsWith('.mp4')) {
            return res.status(400).json({ error: "Invalid file type" });
        }
        
        const filePath = path.join(DB_DIR, 'recordings', filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Recording not found" });
        }
        
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/search-epg - Search available EPG channels
app.get('/api/search-epg', requireAuth, async (req: any, res: any) => {
    try {
        const q = req.query.q as string;
        if (!q || q.length < 2) return res.json([]);

        // Search in the full iptv_org_map table
        const result = await db.execute({
            sql: `SELECT xmltv_id as id, name as display_name FROM iptv_org_map WHERE name LIKE ? OR xmltv_id LIKE ? LIMIT 50`,
            args: [`%${q}%`, `%${q}%`]
        });

        res.json(result.rows);
    } catch (e: any) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// IMDb Metadata Enrichment API Endpoints
// (No API key required - uses free IMDb datasets)
// ============================================

// GET /api/metadata/stats - Get metadata enrichment statistics
app.get('/api/metadata/stats', requireAuth, async (req: any, res: any) => {
    try {
        const stats = await getEnrichmentStats();
        const enabled = await isEnrichmentEnabled();
        res.json({ ...stats, enabled });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/metadata/enrich - Manually trigger metadata enrichment
app.post('/api/metadata/enrich', requireAuth, async (req: any, res: any) => {
    try {
        const enabled = await isEnrichmentEnabled();
        if (!enabled) {
            return res.status(400).json({
                error: 'Metadata enrichment is not enabled. Enable it in configuration first.'
            });
        }

        // Run in background
        enrichProgramsWithMetadata().catch(err => {
            console.error("Manual enrichment failed:", err);
            emitLog(`Enrichment failed: ${err.message} `, "error");
        });

        res.json({ success: true, message: 'Enrichment started in background.' });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/metadata/clear-cache - Clear metadata cache
app.post('/api/metadata/clear-cache', requireAuth, async (req: any, res: any) => {
    try {
        await clearMetadataCache();
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/metadata/refresh-data - Force refresh IMDb datasets
app.post('/api/metadata/refresh-data', requireAuth, async (req: any, res: any) => {
    try {
        // Run in background since it's a large download
        refreshImdbData().catch(err => {
            console.error("IMDb data refresh failed:", err);
            emitLog(`IMDb refresh failed: ${err.message} `, "error");
        });

        res.json({ success: true, message: 'IMDb data refresh started in background.' });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/metadata/config - Save metadata configuration (no API key needed)
app.post('/api/metadata/config', requireAuth, async (req: any, res: any) => {
    try {
        const { enabled } = req.body;

        if (enabled !== undefined) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('metadata_enrichment_enabled', ?)",
                args: [enabled ? 'true' : 'false']
            });
        }

        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/metadata/config', requireAuth, async (req: any, res: any) => {
    try {
        const enabledRes = await db.execute("SELECT value FROM settings WHERE key = 'metadata_enrichment_enabled'");
        const stats = await getEnrichmentStats();

        res.json({
            enabled: enabledRes.rows.length > 0 && enabledRes.rows[0].value === 'true',
            ...stats
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Fetch and update playlist channels from URL
 * Supports multiple playlists - merges and deduplicates channels
 */
async function updatePlaylist(url: string) {
    try {
        emitLog(formatMemorySnapshot('playlist import start', process.memoryUsage(), { source: url }), 'info');
        let playlistStr = '';
        if (url.startsWith('/files/')) {
            const localPath = path.join(DB_DIR, url.replace('/files/', ''));
            playlistStr = fs.readFileSync(localPath, 'utf8');
        } else {
            const response = await axios.get(url, { timeout: 30000 });
            playlistStr = response.data;
        }
        const playlist = parse(playlistStr);
        emitLog(formatMemorySnapshot('playlist parsed', process.memoryUsage(), { source: url, items: playlist.items.length }), 'info');

        // Cache existing channel state to preserve user settings (enabled, EPG matches)
        const currentData = await db.execute("SELECT id, name, url, enabled, matched_epg_id, match_type, channel_number, source_url, tvg_id FROM channels");
        const indexes = buildPlaylistImportIndexes(currentData.rows as any[], url);

        // Delete only channels from this source_url to allow incremental updates
        await db.execute({
            sql: "DELETE FROM channels WHERE source_url = ?",
            args: [url]
        });

        let count = 0;
        let pendingRows: PlaylistChannelRow[] = [];
        const INSERT_BATCH_SIZE = 250;

        const flushRows = async () => {
            if (pendingRows.length === 0) return;
            const placeholders = pendingRows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
            const args = pendingRows.flatMap((row) => ([
                row.id,
                row.name,
                row.tvg_id,
                row.tvg_logo,
                row.group_title,
                row.url,
                row.source_url,
                row.channel_number,
                row.enabled,
                row.matched_epg_id,
                row.match_type
            ]));

            await db.execute('BEGIN TRANSACTION');
            await db.execute({
                sql: `INSERT INTO channels (id, name, tvg_id, tvg_logo, group_title, url, source_url, channel_number, enabled, matched_epg_id, match_type) VALUES ${placeholders}`,
                args
            });
            await db.execute('COMMIT');
            pendingRows = [];
        };

        for (const item of playlist.items) {
            const record = createPlaylistChannelRecord({
                name: item.name || 'Unknown Channel',
                url: item.url,
                tvgId: item.tvg.id || '',
                tvgLogo: item.tvg.logo || '',
                groupTitle: item.group.title || ''
            }, indexes, url, count + 1);

            pendingRows.push(record.row);
            count++;

            if (pendingRows.length >= INSERT_BATCH_SIZE) {
                await flushRows();
            }
        }

        await flushRows();
        playlistStr = '';

        emitLog(formatMemorySnapshot('playlist import complete', process.memoryUsage(), { source: url, imported: count }), 'info');
        emitLog(`Updated playlist. Total channels: ${count}`, "success");
        return count;
    } catch (e: any) {
        console.error("Playlist update failed:", e);
        emitLog(`Playlist update failed: ${e.message}`, "error");
        throw e;
    }
}


// POST /api/metadata/search-tvmaze - Search for shows
app.post('/api/metadata/search-tvmaze', requireAuth, async (req: any, res: any) => {
    try {
        const { query } = req.body;
        if (!query) throw new Error("Missing query");
        const results = await searchTVMazeShows(query);
        res.json(results);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/metadata/override - Save a metadata override
app.post('/api/metadata/override', requireAuth, async (req: any, res: any) => {
    try {
        const { title, tvmaze_id, show_name, genres, rating } = req.body;
        if (!title) throw new Error("Missing title");

        const normalized = normalizeTitle(title);

        if (tvmaze_id) {
            await db.execute({
                sql: "INSERT OR REPLACE INTO metadata_overrides (title_normalized, tvmaze_id, show_name, genres, rating) VALUES (?, ?, ?, ?, ?)",
                args: [normalized, tvmaze_id, show_name, genres, rating]
            });

            // Also update the programs immediately? 
            // The enrichment process will pick it up on next run, but maybe we should apply it now?
            // Let's at least mark matching programs as not enriched so they get picked up? 
            // Or just allow re-enrichment.
            await db.execute({
                sql: "UPDATE epg_programs SET enriched = 0 WHERE title = ?",
                args: [title]
            });
        } else {
            await db.execute({
                sql: "DELETE FROM metadata_overrides WHERE title_normalized = ?",
                args: [normalized]
            });
        }
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// Production-Ready API Endpoints
// ============================================

// GET /api/health - Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const [channelCount, programCount, lastSync] = await Promise.all([
            db.execute("SELECT COUNT(*) as c FROM channels WHERE enabled = 1"),
            db.execute("SELECT COUNT(*) as c FROM epg_programs"),
            db.execute("SELECT MAX(timestamp) as ts FROM grab_logs")
        ]);

        res.json({
            status: 'healthy',
            channels: Number(channelCount.rows[0].c),
            programs: Number(programCount.rows[0].c),
            lastGrab: lastSync.rows[0].ts ? new Date(Number(lastSync.rows[0].ts)).toISOString() : null,
            uptime: process.uptime()
        });
    } catch (e: any) {
        res.status(500).json({ status: 'unhealthy', error: e.message });
    }
});

// GET /api/stats - Comprehensive statistics
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await Promise.all([
            db.execute("SELECT COUNT(*) as c FROM channels"),
            db.execute("SELECT COUNT(*) as c FROM channels WHERE enabled = 1"),
            db.execute("SELECT COUNT(*) as c FROM channels WHERE matched_epg_id IS NOT NULL AND enabled = 1"),
            db.execute("SELECT COUNT(*) as c FROM epg_programs"),
            db.execute("SELECT COUNT(DISTINCT channel_id) as c FROM epg_programs"),
            db.execute("SELECT COUNT(*) as c FROM channel_grab_status WHERE auto_disabled = 1"),
            db.execute("SELECT COUNT(*) as c FROM tvmaze_cache"),
            db.execute("SELECT COUNT(*) as c FROM epg_programs WHERE enriched = 1")
        ]);

        res.json({
            channels: {
                total: Number(stats[0].rows[0].c),
                enabled: Number(stats[1].rows[0].c),
                matched: Number(stats[2].rows[0].c),
                autoDisabled: Number(stats[5].rows[0].c)
            },
            programs: {
                total: Number(stats[3].rows[0].c),
                channels: Number(stats[4].rows[0].c),
                enriched: Number(stats[7].rows[0].c)
            },
            metadata: {
                cachedShows: Number(stats[6].rows[0].c)
            }
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/has-data - Lightweight check: does the system have any channel/EPG data?
// No auth required so the dashboard can show the empty-state prompt before login.
app.get('/api/has-data', async (req, res) => {
    try {
        const [ch, prog, pl] = await Promise.all([
            db.execute("SELECT COUNT(*) as c FROM channels"),
            db.execute("SELECT COUNT(*) as c FROM epg_programs"),
            db.execute("SELECT value FROM settings WHERE key = 'playlist_url'")
        ]);
        res.json({
            hasChannels: Number(ch.rows[0].c) > 0,
            hasPrograms: Number(prog.rows[0].c) > 0,
            hasPlaylist: pl.rows.length > 0 && String(pl.rows[0].value).trim() !== '',
            isEmpty: Number(ch.rows[0].c) === 0 && Number(prog.rows[0].c) === 0
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/channels/auto-disabled', requireAuth, async (req: any, res: any) => {
    try {
        const channels = await getAutoDisabledChannels();
        res.json(channels);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/channels/re-enable - Re-enable auto-disabled channels
app.post('/api/channels/re-enable', requireAuth, async (req: any, res: any) => {
    try {
        const { xmltv_ids } = req.body;
        if (!xmltv_ids || !Array.isArray(xmltv_ids)) {
            throw new Error("Missing or invalid xmltv_ids array");
        }

        const count = await reEnableChannels(xmltv_ids);
        res.json({ success: true, count });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================
// Streaming UI API Endpoints
// ============================================

// GET /api/categories - Get distinct channel categories with counts
app.get('/api/categories', async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT group_title, COUNT(*) as count 
            FROM channels 
            WHERE enabled = 1 AND group_title IS NOT NULL AND group_title != ''
            GROUP BY group_title 
            ORDER BY group_title ASC
    `);
        res.json(result.rows);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/debug-channels', async (req, res) => {
    try {
        const r = await db.execute("SELECT name, group_title, enabled FROM channels LIMIT 10");
        res.json(r.rows);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/guide - EPG guide grid data for the streaming UI
app.get('/api/guide', async (req, res) => {
    try {
        const startParam = req.query.start as string;
        const hours = parseInt(req.query.hours as string) || 3;
        const category = req.query.category as string;
        const categoriesParam = req.query.categories as string; // comma-separated multi-select

        // Calculate time window
        const startTime = startParam ? new Date(startParam) : new Date();
        const endTime = new Date(startTime.getTime() + hours * 60 * 60 * 1000);

        // Format times for EPG comparison (YYYYMMDDHHMMSS +0000)
        const fmtTime = (d: Date) => {
            return d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + '00 +0000';
        };
        const startStr = fmtTime(startTime);
        const endStr = fmtTime(endTime);
        const nowStr = fmtTime(new Date());

        // Get enabled channels with stream URLs
        let channelQuery = `
SELECT
c.id, c.name, c.group_title, c.url, c.tvg_logo, c.channel_number,
    COALESCE(mo.epg_id, c.matched_epg_id) as effective_epg_id
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            WHERE c.enabled = 1 AND c.url IS NOT NULL AND c.url != ''
    `;
        const args: any[] = [];

        // Support multi-category filtering (comma-separated)
        if (categoriesParam) {
            const cats = categoriesParam.split(',').map(c => c.trim()).filter(Boolean);
            if (cats.length > 0) {
                const placeholders = cats.map(() => '?').join(',');
                channelQuery += ` AND c.group_title IN(${placeholders})`;
                args.push(...cats);
            }
        } else if (category && category !== 'all') {
            channelQuery += ` AND c.group_title = ? `;
            args.push(category);
        }

        channelQuery += ` ORDER BY c.channel_number ASC, c.name ASC`;

        const channelsRes = await db.execute({ sql: channelQuery, args });

        // Collect all EPG IDs to fetch programs in one query
        const epgIds = channelsRes.rows
            .map(c => c.effective_epg_id)
            .filter(Boolean) as string[];

        // Get programs in the time window for all channels
        let programsMap = new Map<string, any[]>();
        if (epgIds.length > 0) {
            // Batch query - get all programs that overlap with our window
            const placeholders = epgIds.map(() => '?').join(',');
            const programsRes = await db.execute({
                sql: `
                    SELECT channel_id, title, desc, sub_title, episode_num,
    category, rating, icon, start, stop, tmdb_poster
                    FROM epg_programs 
                    WHERE channel_id IN(${placeholders})
                    AND stop > ? AND start < ?
    ORDER BY start ASC
        `,
                args: [...epgIds, startStr, endStr]
            });

            for (const prog of programsRes.rows) {
                const chId = String(prog.channel_id);
                if (!programsMap.has(chId)) programsMap.set(chId, []);
                programsMap.get(chId)!.push(prog);
            }
        }

        // Also get EPG channel icons
        const epgIconsRes = await db.execute("SELECT id, icon FROM epg_channels");
        const iconMap = new Map<string, string>();
        for (const r of epgIconsRes.rows) {
            if (r.icon) iconMap.set(String(r.id), String(r.icon));
        }

        // Build response
        const channels = channelsRes.rows.map(c => {
            const epgId = c.effective_epg_id ? String(c.effective_epg_id) : null;
            const programs = epgId ? (programsMap.get(epgId) || []) : [];
            const currentProg = programs.find((p: any) => p.start <= nowStr && p.stop > nowStr);

            return {
                id: c.id,
                name: c.name,
                group_title: c.group_title,
                channel_number: c.channel_number,
                logo: c.tvg_logo || (epgId ? iconMap.get(epgId) : null) || null,
                stream_url: `/api/channel/${c.id}/stream`,
                epg_id: epgId,
                current_program: currentProg ? {
                    title: currentProg.title,
                    description: currentProg.desc,
                    sub_title: currentProg.sub_title,
                    episode_num: currentProg.episode_num,
                    start: currentProg.start,
                    stop: currentProg.stop,
                    icon: currentProg.icon || currentProg.tmdb_poster,
                    category: currentProg.category,
                } : null,
                programs: programs.map((p: any) => ({
                    title: p.title,
                    description: p.desc,
                    sub_title: p.sub_title,
                    episode_num: p.episode_num,
                    start: p.start,
                    stop: p.stop,
                    icon: p.icon || p.tmdb_poster,
                    category: p.category,
                    rating: p.rating,
                }))
            };
        });

        res.json({
            start: startTime.toISOString(),
            end: endTime.toISOString(),
            channels
        });
    } catch (e: any) {
        console.error("Guide API error:", e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/channel/:id/programs - Full schedule for one channel (next 24h)
app.get('/api/channel/:id/programs', async (req, res) => {
    try {
        const channelId = req.params.id;

        // Get the channel and its effective EPG ID
        const chRes = await db.execute({
            sql: `
                SELECT c.*, COALESCE(mo.epg_id, c.matched_epg_id) as effective_epg_id
                FROM channels c
                LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
                WHERE c.id = ?
    `,
            args: [channelId]
        });

        if (chRes.rows.length === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const channel = chRes.rows[0];
        const epgId = channel.effective_epg_id ? String(channel.effective_epg_id) : null;

        if (!epgId) {
            return res.json({ channel, programs: [] });
        }

        const now = new Date();
        const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const fmtTime = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + '00 +0000';

        const programsRes = await db.execute({
            sql: `
                SELECT title, desc, sub_title, episode_num, category,
    rating, icon, start, stop, tmdb_poster
                FROM epg_programs 
                WHERE channel_id = ? AND stop > ? AND start < ?
    ORDER BY start ASC
            `,
            args: [epgId, fmtTime(now), fmtTime(end)]
        });

        res.json({
            channel: {
                id: channel.id,
                name: channel.name,
                group_title: channel.group_title,
                channel_number: channel.channel_number,
                logo: channel.tvg_logo,
                stream_url: `/api/channel/${channel.id}/stream`,
            },
            programs: programsRes.rows.map(p => ({
                title: p.title,
                description: p.desc,
                sub_title: p.sub_title,
                episode_num: p.episode_num,
                start: p.start,
                stop: p.stop,
                icon: p.icon || p.tmdb_poster,
                category: p.category,
                rating: p.rating,
            }))
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/channel/:id/stream - Redirect to the channel's stream URL
app.get('/api/channel/:id/stream', async (req, res) => {
    try {
        const channelId = req.params.id;
        const chRes = await db.execute({
            sql: `SELECT url FROM channels WHERE id = ? AND enabled = 1`,
            args: [channelId]
        });

        if (chRes.rows.length === 0 || !chRes.rows[0].url) {
            return res.status(404).json({ error: 'Channel not found or disabled' });
        }

        const hlsUrl = await StreamManager.startStream(channelId, String(chRes.rows[0].url));
        res.redirect(302, hlsUrl);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/recordings/active - Get currently active/upcoming recordings
app.get('/api/recordings/active', requireAuth, async (req: any, res: any) => {
    try {
        const result = await db.execute(
            `SELECT * FROM scheduled_recordings WHERE status IN('scheduled', 'recording') ORDER BY start_time ASC`
        );
        res.json(result.rows);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});
