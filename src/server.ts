import express from 'express';
import { initDb, db, DB_DIR } from './db';
import { getPlaylistCategories, fetchAndSavePlaylist, applyPreMatches } from './services/playlist';
import { getEpgFiles, processEpg, matchChannelsToIptvOrg, generatePlaylistAndEpg, cleanupEpgData } from './services/epg';
import { updateIptvOrgData } from './services/iptv-org';
import { grabMissingChannels, getAutoDisabledChannels, reEnableChannels } from './services/grabber';
import { enrichProgramsWithMetadata, getEnrichmentStats, clearMetadataCache, isEnrichmentEnabled, refreshImdbData } from './services/metadata';
import { getJobStatus, startJob, completeJob } from './job';
import { eventBus, emitLog } from './events';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { tui } from './services/tui';

import schedule from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static('src/public')); // UI
app.use('/files', express.static(DB_DIR)); // Static files

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
        emitLog("Starting full automation cycle...", "info");
        
        // 1. Refresh Playlist
        const plResult = await db.execute("SELECT value FROM settings WHERE key = 'playlist_url'");
        if (plResult.rows.length > 0) {
            const url = plResult.rows[0].value as string;
            emitLog(`Refreshing playlist from source: ${url}`, "info");
            await fetchAndSavePlaylist(url);
        }

        // 2. Update IPTV-ORG Metadata & Match
        emitLog("Updating IPTV-ORG metadata and matching channels...", "info");
        await updateIptvOrgData();
        const matchedCount = await matchChannelsToIptvOrg();
        emitLog(`Matching complete. Total matched: ${matchedCount}`, "success");

        // 3. Full EPG Grab for all enabled and matched channels
        const daysResult = await db.execute("SELECT value FROM settings WHERE key = 'epg_days'");
        const epgDays = daysResult.rows.length > 0 ? parseInt(String(daysResult.rows[0].value)) : 2;
        
        // Get all enabled/matched channels with site mappings
        const enabled = await db.execute(`
            SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id) as xmltv_id 
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            INNER JOIN iptv_org_map m ON COALESCE(mo.epg_id, c.matched_epg_id) = m.xmltv_id
            WHERE (c.matched_epg_id IS NOT NULL OR mo.epg_id IS NOT NULL)
            AND m.site IS NOT NULL
            AND c.enabled = 1
        `);
        const ids = enabled.rows.map(r => String(r.xmltv_id));
        
        if (ids.length > 0) {
            emitLog(`Triggering EPG refresh for ${ids.length} channels (${epgDays} days)...`, "info");
            await grabMissingChannels(ids);
        } else {
            emitLog(`No matched channels with site mappings found.`, "warning");
        }

        // 4. Enrich EPG programs with IMDb metadata (if enabled)
        const enrichmentEnabled = await isEnrichmentEnabled();
        let enrichmentStats = null;
        if (enrichmentEnabled) {
            emitLog("Enriching EPG data with IMDb metadata...", "info");
            enrichmentStats = await enrichProgramsWithMetadata();
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
            customGrabCount: ids.length
        };
        if (enrichmentStats) {
            stats.enrichment = enrichmentStats;
        }
        completeJob(stats);
        eventBus.emit('report', stats);
        emitLog(`Automation cycle complete! ${result.playlistCount} channels matched and exported.`, "success");
        
    } catch (e: any) {
        emitLog(`Automation failed: ${e.message}`, "error");
        console.error("Full sync error:", e);
    }
}


// Daily Automation Cycle (Every day at 02:00)
schedule.schedule('0 2 * * *', async () => {
    emitLog("Running scheduled daily automation cycle...", "info");
    runFullSync().catch(e => console.error("Scheduled full sync failed:", e));
});

app.get('/api/settings', async (req, res) => {
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
app.get('/api/channels-with-programs', async (req, res) => {
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
    res.json(getJobStatus());
});

app.get('/api/playlists', async (req, res) => {
    try {
        const categories = await getPlaylistCategories();
        res.json(categories);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/select-playlist', async (req, res) => {
    try {
        const { url } = req.body;
        const count = await fetchAndSavePlaylist(url);
        res.json({ count });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/epg-files', async (req, res) => {
    try {
        const files = await getEpgFiles();
        res.json(files);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/grab-logs', async (req, res) => {
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

app.post('/api/select-epg', async (req, res) => {
    // Legacy endpoint, now triggers full sync
    runFullSync().catch(e => console.error("API triggered sync failed:", e));
    res.json({ success: true, message: "Sync started in background." });
});

app.post('/api/grab', async (req, res) => {
    try {
        // Trigger grab for all pre-matched channels that are currently missing guide data
        const missing = await db.execute(`
            SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id) as xmltv_id 
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            LEFT JOIN epg_programs p ON COALESCE(mo.epg_id, c.matched_epg_id) = p.channel_id
            WHERE (c.matched_epg_id IS NOT NULL OR mo.epg_id IS NOT NULL)
            AND p.channel_id IS NULL
            AND c.enabled = 1
        `);
        const ids = missing.rows.map(r => String(r.xmltv_id));
        if (ids.length === 0) {
            return res.json({ success: true, message: "No missing guide data found for matched channels." });
        }
        
        // Run in background but return success that it started
        grabMissingChannels(ids).catch(err => {
            console.error("Grab failed:", err);
            emitLog(`Grab failed: ${err.message}`, "error");
        });
        res.json({ success: true, count: ids.length });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/rebuild-files', async (req, res) => {
    try {
        await cleanupEpgData();
        const result = await generatePlaylistAndEpg();
        res.json({ success: true, stats: result });
    } catch (e: any) {
        console.error("Manual rebuild failed:", e);
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

    app.listen(PORT, () => {
        emitLog(`Server running on port ${PORT}`, "success");
    });

    // Startup Automation: Ensure data is loaded and updated (in background)
    emitLog("Checking for initial data sync...", "info");
    const plResult = await db.execute("SELECT value FROM settings WHERE key = 'playlist_url'");
    if (plResult.rows.length > 0) {
        emitLog("Playlist configured. Triggering background sync...", "info");
        runFullSync().catch(e => console.error("Startup full sync failed:", e));
    } else {
        emitLog("No playlist configured. Waiting for user setup.", "info");
        updateIptvOrgData().catch(err => console.error("Failed startup IPTV-ORG update:", err));
    }
}

startServer().catch(err => {
    console.error("Critical server failure:", err);
    process.exit(1);
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

    // GET /api/config - Unified config
    app.get('/api/config', async (req, res) => {
        try {
            const settingsRes = await db.execute("SELECT * FROM settings");
            const config: any = {};
            for (const row of settingsRes.rows) {
                if (row.key === 'epg_urls') {
                    config.epg_urls = []; 
                } else {
                    config[row.key as string] = row.value;
                }
            }
            res.json(config);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/config - Save config & Trigger actions
    app.post('/api/config', async (req, res) => {
        try {
            const { playlist_url, epg_urls, preferred_lang, epg_days } = req.body;
            
            // Get current playlist url to see if it changed
            const currentRes = await db.execute("SELECT value FROM settings WHERE key = 'playlist_url'");
            const currentUrl = currentRes.rows.length > 0 ? currentRes.rows[0].value : null;

            if (playlist_url) {
                await db.execute({
                    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_url', ?)",
                    args: [playlist_url]
                });

                // If changed, trigger fetch & map
                if (playlist_url !== currentUrl) {
                    emitLog("Playlist URL changed, fetching and mapping...", "info");
                    await fetchAndSavePlaylist(playlist_url);
                }
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
    app.get('/api/mapping', async (req, res) => {
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
                WHERE id IN (SELECT MAX(id) FROM grab_logs GROUP BY xmltv_id)
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
    app.post('/api/override', async (req, res) => {
        try {
            const { channel_id, epg_id } = req.body;
            if (!channel_id) throw new Error("Missing channel_id");
            
            if (epg_id) {
                await db.execute({
                    sql: "INSERT OR REPLACE INTO manual_overrides (channel_id, epg_id) VALUES (?, ?)",
                    args: [channel_id, epg_id]
                });
            } else {
                // If epg_id is null/empty, delete override? Or store null to force unmatched?
                // Let's assume delete means "reset to auto". 
                // If user wants to force "No Match", we might need a specific flag.
                // For now, assume clear override.
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
    app.post('/api/channels/toggle', async (req, res) => {
        try {
            const { ids, enabled } = req.body;
            if (!ids || !Array.isArray(ids)) throw new Error("Missing or invalid ids array");
            
            const newStatus = enabled ? 1 : 0;
            const placeholders = ids.map(() => "?").join(",");
            
            await db.execute({
                sql: `UPDATE channels SET enabled = ? WHERE id IN (${placeholders})`,
                args: [newStatus, ...ids]
            });
            
            res.json({ success: true });
        } catch (e: any) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/search-epg - Search available EPG channels
    app.get('/api/search-epg', async (req, res) => {
        try {
            const q = req.query.q as string;
            if (!q || q.length < 2) return res.json([]);
            
            // Search in epg_channels
            // We can use LIKE or FTS if we had it. LIKE is fine for basic search.
            const result = await db.execute({
                sql: `SELECT id, display_name, icon, source FROM epg_channels WHERE display_name LIKE ? OR id LIKE ? LIMIT 50`,
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
    app.get('/api/metadata/stats', async (req, res) => {
        try {
            const stats = await getEnrichmentStats();
            const enabled = await isEnrichmentEnabled();
            res.json({ ...stats, enabled });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/metadata/enrich - Manually trigger metadata enrichment
    app.post('/api/metadata/enrich', async (req, res) => {
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
                emitLog(`Enrichment failed: ${err.message}`, "error");
            });
            
            res.json({ success: true, message: 'Enrichment started in background.' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/metadata/clear-cache - Clear metadata cache
    app.post('/api/metadata/clear-cache', async (req, res) => {
        try {
            await clearMetadataCache();
            res.json({ success: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/metadata/refresh-data - Force refresh IMDb datasets
    app.post('/api/metadata/refresh-data', async (req, res) => {
        try {
            // Run in background since it's a large download
            refreshImdbData().catch(err => {
                console.error("IMDb data refresh failed:", err);
                emitLog(`IMDb refresh failed: ${err.message}`, "error");
            });
            
            res.json({ success: true, message: 'IMDb data refresh started in background.' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/metadata/config - Save metadata configuration (no API key needed)
    app.post('/api/metadata/config', async (req, res) => {
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

    // GET /api/metadata/config - Get metadata configuration
    app.get('/api/metadata/config', async (req, res) => {
        try {
            const enabledRes = await db.execute("SELECT value FROM settings WHERE key = 'metadata_enrichment_enabled'");
            const stats = await getEnrichmentStats();
            
            res.json({
                enabled: enabledRes.rows.length > 0 && enabledRes.rows[0].value === 'true',
                imdb_data_age: stats.imdbDataAge
            });
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

    // GET /api/channels/auto-disabled - View auto-disabled channels
    app.get('/api/channels/auto-disabled', async (req, res) => {
        try {
            const channels = await getAutoDisabledChannels();
            res.json(channels);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/channels/re-enable - Re-enable auto-disabled channels
    app.post('/api/channels/re-enable', async (req, res) => {
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
