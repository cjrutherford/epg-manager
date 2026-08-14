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
import { getJobStatus, startJob, completeJob, requestJobCancel, loadLastJobStateOnBoot } from './job';
import { eventBus, emitLog, emitProgress, emitProgressComplete } from './events';
import { startRecordingScheduler, stopRecordingScheduler, drainRecordings, cancelRecording as cancelRec, getRecordingFilePath, checkScheduledRecordings, startRecording, stopRecording, safeRecordingPath, getFreeSpaceBytes, getVolumeUsage, getRetentionPolicy } from './recorder';
import { formatBytes, meetsFreeSpaceFloor } from './services/recording-storage';
import { StreamManager } from './services/stream';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { tui } from './services/tui';
import { formatMemorySnapshot } from './services/memory';
import { buildPlaylistImportIndexes, createPlaylistChannelRecord, type PlaylistChannelRow } from './services/playlist-import';
import { describePlaylist } from './services/playlist-metadata';
import { mapSystemRecordingRow } from './services/recordings';
import { dedupeChannelsForDisplay } from './services/channel-dedup';
import { setOpenCorsHeaders } from './http-headers';
import { rankEpgSources } from './services/epg-sources';
import { redactUrl } from './services/sources/descriptor';
import { checkScopeCoverage, isResetScope, planReset } from './services/reset-scopes';
import {
    checkThrottle,
    generateToken,
    hashToken,
    isSessionValid,
    isWeakPassword,
    passwordMatches,
    pruneAttemptStates,
    pruneExpiredSessions,
    registerFailure,
    registerSuccess,
    type LoginAttemptState
} from './services/sessions';

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

app.set('trust proxy', true);

// Enable CORS for API clients
app.use((req: any, res: any, next: any) => {
    setOpenCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
});
app.use(express.json());

// Backend runs purely as an API server

app.use('/files/streams/:id', (req, res, next) => {
    StreamManager.keepAlive(req.params.id);
    next();
});
app.get('/api/stream/keepalive/:id', (req: any, res: any) => {
    StreamManager.keepAlive(req.params.id);
    res.json({ success: true, timestamp: Date.now() });
});
// Recordings are served by a validated handler, registered ahead of the static
// mount below. express.static resolves `recordings/../local.db` inside its own
// root and would happily serve it, so this route has to win the match.
app.get('/files/recordings/:filename', (req: any, res: any) => {
    const filePath = safeRecordingPath(req.params.filename);
    if (!filePath) {
        return res.status(400).json({ error: "Invalid recording filename" });
    }
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Recording not found" });
    }

    res.header('Content-Type', 'video/mp4');
    res.header('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    res.sendFile(filePath);
});

// ── /files: explicitly scoped, never the whole data directory ──
//
// This used to be `express.static(DB_DIR)`, which served local.db — settings,
// playlist URLs with any embedded credentials, the full schedule — to anyone.
// Each subtree is now mounted deliberately, and anything not listed 404s.

// Viewer scope: HLS segments the player fetches directly.
app.use('/files/streams', express.static(path.join(DB_DIR, 'streams'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// Admin scope: the iptv-org playlist catalogue browsed from Settings.
// Import reads these off disk, so this mount is for browsing only.
app.use('/files/iptv-org-playlists', requireAuth, express.static(path.join(DB_DIR, 'iptv-org-playlists')));

// Anything else under /files is not public data.
app.use('/files', (req: any, res: any) => {
    res.status(404).json({ error: 'Not found' });
});


// ── Sessions ──────────────────────────────────
//
// Sessions live in SQLite so a restart no longer silently signs everyone out,
// with an in-memory index (tokenHash -> expiresAt) so the hot path stays a map
// lookup rather than a query per request. Tokens are stored hashed.

const SESSION_TTL_MS = Math.max(1, parseInt(process.env.SESSION_TTL_HOURS || '168', 10)) * 60 * 60 * 1000;
const sessionIndex = new Map<string, number>();
const loginAttempts = new Map<string, LoginAttemptState>();

async function loadSessionsOnBoot(): Promise<void> {
    try {
        const now = Date.now();
        await db.execute({ sql: 'DELETE FROM admin_sessions WHERE expires_at <= ?', args: [now] });
        const result = await db.execute('SELECT token_hash, expires_at FROM admin_sessions');
        for (const row of result.rows) {
            sessionIndex.set(String(row.token_hash), Number(row.expires_at));
        }
        if (sessionIndex.size > 0) {
            // console, not emitLog: this runs before tui.init() and would not be rendered
            console.log(`[Auth] Restored ${sessionIndex.size} active session(s).`);
        }
    } catch (e: any) {
        console.error('[Auth] Failed to load sessions:', e.message);
    }
}

async function sweepSessions(): Promise<void> {
    const now = Date.now();
    const expired = pruneExpiredSessions(sessionIndex, now);
    pruneAttemptStates(loginAttempts, now);
    if (expired.length === 0) return;
    try {
        await db.execute({ sql: 'DELETE FROM admin_sessions WHERE expires_at <= ?', args: [now] });
        console.log(`[Auth] Expired ${expired.length} session(s).`);
    } catch (e: any) {
        console.error('[Auth] Failed to sweep sessions:', e.message);
    }
}

async function createSession(): Promise<{ token: string; expiresAt: number }> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    await db.execute({
        sql: 'INSERT OR REPLACE INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
        args: [tokenHash, now, expiresAt]
    });
    sessionIndex.set(tokenHash, expiresAt);
    return { token, expiresAt };
}

async function destroySession(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    sessionIndex.delete(tokenHash);
    try {
        await db.execute({ sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', args: [tokenHash] });
    } catch (e: any) {
        console.error('[Auth] Failed to delete session:', e.message);
    }
}

function bearerToken(req: any): string | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return token || null;
}

/** True when the request carries a live session. Expired tokens are evicted on sight. */
function hasValidSession(req: any): boolean {
    const token = bearerToken(req);
    if (!token) return false;

    const tokenHash = hashToken(token);
    const expiresAt = sessionIndex.get(tokenHash);
    if (isSessionValid(expiresAt, Date.now())) return true;

    if (expiresAt !== undefined) {
        sessionIndex.delete(tokenHash);
        db.execute({ sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', args: [tokenHash] })
            .catch(() => { /* best effort */ });
    }
    return false;
}

// ── Auth endpoints ────────────────────────────

app.post('/api/auth', async (req: any, res: any) => {
    const clientKey = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();

    // Throttle before touching the password, so guessing costs time
    const verdict = checkThrottle(loginAttempts.get(clientKey), now);
    if (!verdict.allowed) {
        const seconds = Math.ceil(verdict.retryAfterMs / 1000);
        res.setHeader('Retry-After', String(seconds));
        return res.status(429).json({
            error: `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`
        });
    }

    if (!passwordMatches(req.body?.password, ADMIN_PASSWORD)) {
        loginAttempts.set(clientKey, registerFailure(loginAttempts.get(clientKey), now));
        return res.status(401).json({ error: 'Invalid password' });
    }

    loginAttempts.set(clientKey, registerSuccess());
    try {
        const { token, expiresAt } = await createSession();
        res.json({ success: true, token, expiresAt });
    } catch (e: any) {
        console.error('[Auth] Failed to create session:', e.message);
        res.status(500).json({ error: 'Could not start a session' });
    }
});

app.get('/api/auth/status', (req: any, res: any) => {
    if (hasValidSession(req)) {
        return res.json({ authenticated: true });
    }
    res.json({ authenticated: false, required: true });
});

app.post('/api/auth/logout', async (req: any, res: any) => {
    const token = bearerToken(req);
    if (token) await destroySession(token);
    res.json({ success: true });
});

// ── Auth middleware for admin routes ──────────
function requireAuth(req: any, res: any, next: any) {
    if (hasValidSession(req)) return next();
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
let hasPendingScheduledSync = false;

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
        emitLog("Sync already in progress. Queuing delayed sync...", "warning");
        hasPendingScheduledSync = true;
        return;
    }

    await startJob('full_sync');
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
            emitProgress(`Refreshing ${playlistUrls.length} playlist(s)...`, 0, playlistUrls.length, 'playlist');
            for (let i = 0; i < playlistUrls.length; i++) {
                const url = playlistUrls[i];
                if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");
                try {
                    emitLog(`Loading playlist: ${url}`, "info");
                    await updatePlaylist(url);
                    emitProgress(`Loaded playlist ${i + 1}/${playlistUrls.length}`, i + 1, playlistUrls.length, 'playlist');
                } catch (e: any) {
                    emitLog(`Failed to load playlist ${url}: ${e.message}`, "error");
                }
            }
            emitProgressComplete('playlist', 'Playlist refresh complete', playlistUrls.length);
        } else {
            emitLog("No playlist configured.", "warning");
            emitProgressComplete('playlist', 'No playlist configured', 0);
        }

        if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");
        // 2. Update IPTV-ORG Metadata & Match — stream newly matched IDs into the grabber
        //    as matching progresses, so EPG grabs start immediately rather than waiting
        //    for all 1,000+ channels to finish matching first.
        emitLog("Updating IPTV-ORG metadata and matching channels...", "info");
        emitProgress('Updating IPTV-ORG metadata...', 0, 1, 'metadata');
        await updateIptvOrgData();
        invalidateIptvOrgCache(); // matching cache now stale — will reload on next matchChannelsToIptvOrg call

        if (getJobStatus().cancelRequested) throw new Error("Sync cancelled by user");
        const daysResult = await db.execute("SELECT value FROM settings WHERE key = 'epg_days'");
        const epgDays = daysResult.rows.length > 0 ? String(daysResult.rows[0].value) : '2';

        // Initialize our streaming pipeline queue
        const pipeline = new PipelineQueue(epgDays);
        activePipeline = pipeline;

        // Run matching for channels; matched IDs stream into grabber as they match
        const matchedCount = await matchChannelsToIptvOrg((newIds) => {
            if (newIds.length === 0) return;
            emitLog(`[Pipeline] Queuing batch of ${newIds.length} matched channels for EPG grab...`, "info");
            pipeline.enqueueMatched(newIds);
        });
        // Get total enabled channel count from channels table
        const totalChannelsRes = await db.execute("SELECT COUNT(*) as c FROM channels WHERE enabled = 1");
        const totalChannelsCount = Number(totalChannelsRes.rows[0]?.c || matchedCount);
        const unmatchedCount = Math.max(0, totalChannelsCount - matchedCount);

        // Tell the pipeline no more matches are coming
        await pipeline.setMatchingComplete(totalChannelsCount, matchedCount, unmatchedCount);

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
        emitProgress('Cleaning up EPG data...', 0, 3, 'rebuild');
        await cleanupEpgData();
        emitProgress('Cleanup complete. Preparing final files...', 1, 3, 'rebuild');
        emitLog("Generating final M3U and XML files...", "info");
        emitProgress('Generating final M3U and XML files...', 2, 3, 'rebuild');
        const result = await generatePlaylistAndEpg();
        emitProgressComplete('rebuild', 'Final M3U and XML files generated', 3);

        // 6. Complete
        const totalChannels = await db.execute("SELECT COUNT(*) as c FROM channels");
        const stats: any = {
            channelsProcessed: result.epgChannels,
            programsProcessed: result.epgPrograms,
            channelsMatched: result.playlistCount,
            totalChannels: Number(totalChannels.rows[0].c),
            filesGenerated: ['playlist.m3u', 'epg.xml'],
            customGrabCount: matchedCount
        };
        if (enrichmentStats) {
            stats.enrichment = enrichmentStats;
        }
        await completeJob(stats);
        eventBus.emit('report', stats);
        emitLog(`Automation cycle complete! ${result.playlistCount} channels matched and exported.`, "success");

    } catch (e: any) {
        emitLog(`Automation failed: ${e.message} `, "error");
        console.error("Full sync error:", e);
        await completeJob(null, e.message);
        eventBus.emit('report', { error: e.message });
    } finally {
        activePipeline = null;
        if (hasPendingScheduledSync) {
            hasPendingScheduledSync = false;
            emitLog("Processing queued pending sync job...", "info");
            setTimeout(() => {
                runFullSync().catch(err => console.error("Queued sync failed:", err));
            }, 1000);
        }
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
        if (!settings.channel_numbering_mode) {
            settings.channel_numbering_mode = 'auto-group';
        }
        if (!settings.metadata_enrichment_enabled) {
            settings.metadata_enrichment_enabled = 'true';
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
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    res.write(': connected\n\n');
    const heartbeat = setInterval(() => {
        res.write(`: keep-alive ${Date.now()}\n\n`);
    }, 15000);

    const onLog = (log: any) => sendEvent('log', log);
    const onProgress = (prog: any) => sendEvent('progress', prog);
    const onReport = (report: any) => sendEvent('report', report);

    eventBus.on('log', onLog);
    eventBus.on('progress', onProgress);
    eventBus.on('report', onReport);

    req.on('close', () => {
        clearInterval(heartbeat);
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
        const status = getJobStatus();
        if (status.running) {
            return res.json({ success: false, message: "Sync already in progress." });
        }
        const plResult = await db.execute("SELECT value FROM settings WHERE key = 'playlist_url'");
        if (plResult.rows.length === 0) {
            return res.status(400).json({ error: "No playlist URL configured." });
        }
        const url = String(plResult.rows[0].value);
        // Fire in background — return immediately so the client doesn't wait on network I/O
        (async () => {
            startJob();
            try {
                emitLog(`Reloading playlist from: ${url}`, "info");
                emitProgress("Reloading playlist...", 0, 1, 'playlist');
                const count = await updatePlaylist(url);
                emitLog(`Playlist reloaded: ${count} channels imported.`, "success");
                emitProgressComplete('playlist', `Playlist reload complete: ${count} channels imported`, 1);
                const stats = {
                    channelsProcessed: count,
                    programsProcessed: 0,
                    channelsMatched: 0,
                    totalChannels: count,
                    filesGenerated: [],
                    customGrabCount: 0
                };
                completeJob(stats);
                eventBus.emit('report', stats);
            } catch (e: any) {
                emitLog(`Playlist reload failed: ${e.message}`, "error");
                completeJob(null);
            }
        })();
        res.json({ success: true, message: "Playlist reload started in background." });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/grab', requireAuth, async (req: any, res: any) => {
    try {
        const status = getJobStatus();
        if (status.running) {
            return res.json({ success: false, message: "Sync already in progress." });
        }
        // Trigger grab for all matched and enabled channels
        const matched = await db.execute(`
            SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id) as xmltv_id 
            FROM channels c
            LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
            WHERE (c.matched_epg_id IS NOT NULL OR mo.epg_id IS NOT NULL)
            AND c.enabled = 1
        `);
        const ids = matched.rows.map(r => String(r.xmltv_id)).filter(Boolean);
        if (ids.length === 0) {
            return res.json({ success: true, message: "No matched and enabled channels found to grab." });
        }

        // Run in background using PipelineQueue so grabs stream into enrichment
        (async () => {
            startJob();
            try {
                const daysResult = await db.execute("SELECT value FROM settings WHERE key = 'epg_days'");
                const epgDays = daysResult.rows.length > 0 ? String(daysResult.rows[0].value) : '2';

                const pipeline = new PipelineQueue(epgDays);
                activePipeline = pipeline;

                emitProgressComplete('match', `Match stage skipped (using ${ids.length} existing channel matches)`, ids.length);
                await pipeline.enqueueMatched(ids);
                await pipeline.setMatchingComplete(ids.length, ids.length, 0);

                await pipeline.waitForCompletion();

                let enrichmentStats = null;
                if (await isEnrichmentEnabled()) {
                    enrichmentStats = await getEnrichmentStats();
                }

                const stats: any = {
                    channelsProcessed: 0,
                    programsProcessed: 0,
                    channelsMatched: 0,
                    totalChannels: 0,
                    filesGenerated: [],
                    customGrabCount: ids.length
                };
                if (enrichmentStats) {
                    stats.enrichment = enrichmentStats;
                }
                completeJob(stats);
                eventBus.emit('report', stats);
            } catch (err: any) {
                console.error("Grab failed:", err);
                emitLog(`Grab failed: ${err.message}`, "error");
                completeJob(null);
            } finally {
                activePipeline = null;
            }
        })();
        res.json({ success: true, count: ids.length });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/grab/sources', requireAuth, async (req: any, res: any) => {
    try {
        const siteStatusRes = await db.execute("SELECT * FROM site_status");
        const channelSiteStatsRes = await db.execute(`
            SELECT site, 
                   SUM(success_count) as total_success, 
                   SUM(failure_count) as total_failure, 
                   AVG(last_program_count) as avg_programs
            FROM channel_site_status
            GROUP BY site
        `);
        
        const siteMap = new Map();
        for (const row of siteStatusRes.rows) {
            siteMap.set(row.site, {
                site: row.site,
                last_attempt: row.last_attempt,
                last_success: row.last_success,
                overall_failure_count: row.failure_count,
                channels_success: 0,
                channels_failure: 0,
                avg_programs: 0
            });
        }
        
        for (const row of channelSiteStatsRes.rows) {
            const site = String(row.site);
            if (!siteMap.has(site)) {
                siteMap.set(site, {
                    site,
                    last_attempt: null,
                    last_success: null,
                    overall_failure_count: 0,
                    channels_success: 0,
                    channels_failure: 0,
                    avg_programs: 0
                });
            }
            const s = siteMap.get(site);
            s.channels_success = Number(row.total_success) || 0;
            s.channels_failure = Number(row.total_failure) || 0;
            s.avg_programs = Math.round(Number(row.avg_programs) || 0);
        }
        
        res.json(Array.from(siteMap.values()));
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** Pull the fetch url out of a stored descriptor for display, if present. */
function safeConfigUrl(configJson: string): string {
    try {
        const parsed = JSON.parse(configJson);
        return typeof parsed?.fetch?.url === 'string' ? parsed.fetch.url : '';
    } catch {
        return '';
    }
}

app.get('/api/epg-sources', requireAuth, async (req: any, res: any) => {
    try {
        const result = await db.execute(`
            SELECT
                es.*,
                COALESCE(SUM(css.success_count), 0) as channels_success,
                COALESCE(SUM(css.failure_count), 0) as channels_failure,
                COALESCE(AVG(NULLIF(css.last_program_count, 0)), 0) as avg_programs,
                MAX(css.last_attempt) as last_attempt
            FROM sources es
            LEFT JOIN epg_source_channels esc ON esc.source_key = es.key
            LEFT JOIN channel_site_status css
                ON css.xmltv_id = esc.xmltv_id AND css.site = esc.site
            GROUP BY es.key
        `);
        const sources = rankEpgSources(result.rows.map((row: any) => ({
            key: String(row.key),
            provider: String(row.provider),
            site: String(row.site),
            label: String(row.label || row.site),
            enabled: Number(row.enabled) === 1,
            priority: Number(row.priority) || 0,
            grab_capable: Number(row.grab_capable) === 1,
            channelCountEstimate: row.channel_count_estimate === null || row.channel_count_estimate === undefined ? null : Number(row.channel_count_estimate),
            importedRows: Number(row.imported_rows) || 0,
            last_sync_at: row.last_sync_at ? Number(row.last_sync_at) : null,
            last_sync_status: row.last_sync_status || null,
            last_error: row.last_error || null,
            kind: row.kind || null,
            provides: row.provides ? String(row.provides).split(',') : [],
            // Never let a credential-bearing url reach the client.
            configUrl: row.config_json ? redactUrl(safeConfigUrl(String(row.config_json))) : null,
            hasCredentials: !!row.credential_ref,
            notes: row.notes || '',
            channels_success: Number(row.channels_success) || 0,
            channels_failure: Number(row.channels_failure) || 0,
            avg_programs: Math.round(Number(row.avg_programs) || 0),
            last_attempt: row.last_attempt ? Number(row.last_attempt) : null
        })));
        res.json(sources);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/epg-sources/:key/toggle', requireAuth, async (req: any, res: any) => {
    try {
        const key = String(req.params.key);
        const enabled = req.body?.enabled === true || req.body?.enabled === 1;
        const result = await db.execute({
            sql: `UPDATE sources SET enabled = ? WHERE key = ?`,
            args: [enabled ? 1 : 0, key]
        });
        invalidateIptvOrgCache();
        res.json({ success: true, updated: result.rowsAffected || 0 });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/epg-sources/sync', requireAuth, async (req: any, res: any) => {
    try {
        updateIptvOrgData()
            .then(() => invalidateIptvOrgCache())
            .catch((e: any) => emitLog(`EPG source sync failed: ${e.message}`, 'error'));
        res.json({ success: true, message: 'EPG source sync started in background.' });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/match/analysis', requireAuth, async (req: any, res: any) => {
    try {
        const channelsRes = await db.execute("SELECT id, name, group_title, matched_epg_id, match_type, enabled FROM channels");
        const channels = channelsRes.rows;
        
        const total = channels.length;
        let matchedCount = 0;
        const typeBreakdown: Record<string, number> = {};
        
        for (const ch of channels) {
            if (ch.matched_epg_id) {
                matchedCount++;
                let type = 'Auto Matched';
                const matchTypeStr = String(ch.match_type || '');
                if (matchTypeStr.includes('Manual Override')) type = 'Manual Override';
                else if (matchTypeStr.includes('Confirmed Match')) type = 'User Confirmed';
                else if (matchTypeStr.includes('Exact ID')) type = 'Exact ID Match';
                else if (matchTypeStr.includes('Normalized ID')) type = 'Normalized ID Match';
                else if (matchTypeStr.includes('Exact Name')) type = 'Exact Name Match';
                else if (matchTypeStr.includes('Word-Order')) type = 'Word-Order Match';
                else if (matchTypeStr.includes('Fuzzy')) type = 'Fuzzy Match';
                
                typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
            } else {
                typeBreakdown['Unmatched'] = (typeBreakdown['Unmatched'] || 0) + 1;
            }
        }
        
        res.json({
            metrics: {
                total,
                matched: matchedCount,
                unmatched: total - matchedCount,
                match_rate: total > 0 ? Math.round((matchedCount / total) * 100) : 0
            },
            type_breakdown: typeBreakdown,
            channels: channels.map(ch => ({
                id: ch.id,
                name: ch.name,
                group: ch.group_title,
                matched_epg_id: ch.matched_epg_id,
                match_type: ch.match_type,
                enabled: ch.enabled
            }))
        });
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

/** Bytes on disk for a file or directory under DB_DIR, 0 when absent. */
function measurePath(target: string): number {
    try {
        const stat = fs.statSync(target);
        if (stat.isFile()) return stat.size;
        if (!stat.isDirectory()) return 0;
        let total = 0;
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
            total += measurePath(path.join(target, entry.name));
        }
        return total;
    } catch (_) {
        return 0;
    }
}

// GET /api/reset/preview?scope=... - What would this scope destroy?
app.get('/api/reset/preview', requireAuth, async (req: any, res: any) => {
    try {
        const scope = req.query.scope;
        if (!isResetScope(scope)) {
            return res.status(400).json({ error: "Unknown reset scope. Expected one of: guide, user, collection, all." });
        }

        const plan = planReset(scope);
        const tables: { table: string; rows: number }[] = [];
        for (const table of plan.tables) {
            try {
                const result = await db.execute(`SELECT COUNT(*) as c FROM ${table}`);
                tables.push({ table, rows: Number(result.rows[0].c) });
            } catch (_) {
                // Table not present in this database — nothing to clear.
            }
        }

        const paths = [...plan.files, ...plan.dirs]
            .map(name => ({ name, bytes: measurePath(path.join(DB_DIR, name)) }))
            .filter(entry => entry.bytes > 0);

        res.json({
            scope,
            summary: plan.summary,
            totalRows: tables.reduce((sum, entry) => sum + entry.rows, 0),
            totalBytes: paths.reduce((sum, entry) => sum + entry.bytes, 0),
            tables: tables.filter(entry => entry.rows > 0),
            paths
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/reset - Clear a declared scope, in place
app.post('/api/reset', requireAuth, async (req: any, res: any) => {
    try {
        const scope = req.body?.scope;
        if (!isResetScope(scope)) {
            return res.status(400).json({ error: "Unknown reset scope. Expected one of: guide, user, collection, all." });
        }

        // A reset mid-sync would race the pipeline writing into the tables
        // being cleared, and leave the job pointing at rows that no longer exist.
        if (getJobStatus().running) {
            return res.status(409).json({
                error: "A sync is currently running. Cancel it before resetting."
            });
        }

        const plan = planReset(scope);
        emitLog(`Resetting scope '${scope}'...`, "warning");

        // Truncate in place. The database file is never unlinked — the libsql
        // client holds it open, and deleting it would leave every subsequent
        // write going to an unlinked inode.
        let clearedTables = 0;
        for (const table of plan.tables) {
            try {
                await db.execute(`DELETE FROM ${table}`);
                clearedTables++;
            } catch (_) { /* table may not exist in this database */ }
        }
        emitLog(`Cleared ${clearedTables} table(s).`, "info");

        for (const name of plan.files) {
            const target = path.join(DB_DIR, name);
            try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) {}
        }
        for (const name of plan.dirs) {
            const target = path.join(DB_DIR, name);
            try {
                if (fs.existsSync(target)) {
                    fs.rmSync(target, { recursive: true, force: true });
                    emitLog(`Removed ${name}/`, "info");
                }
            } catch (_) {}
        }

        // Reclaim the freed pages without dropping the connection.
        try { await db.execute("VACUUM"); } catch (_) {}

        emitLog(`Reset complete (${scope}).`, "success");
        res.json({ success: true, scope, clearedTables });
    } catch (e: any) {
        console.error("Reset failed:", e);
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

/**
 * Every table must belong to exactly one reset scope. A table added to the
 * schema without being classified would silently survive every reset, so it is
 * surfaced at boot rather than discovered when someone's wipe leaves data behind.
 */
async function verifyResetScopeCoverage() {
    try {
        const result = await db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        );
        const liveTables = result.rows.map(row => String(row.name));
        const coverage = checkScopeCoverage(liveTables);

        if (coverage.unassigned.length > 0) {
            emitLog(
                `Reset scopes do not cover: ${coverage.unassigned.join(', ')}. These tables would survive every reset — classify them in reset-scopes.ts.`,
                "warning"
            );
        }
        if (coverage.duplicated.length > 0) {
            emitLog(`Reset scopes list these tables more than once: ${coverage.duplicated.join(', ')}.`, "warning");
        }
    } catch (e: any) {
        console.error("Reset scope coverage check failed:", e.message);
    }
}

async function startServer() {
    emitLog("Initializing database...", "info");
    await initDb();
    await loadLastJobStateOnBoot();
    await verifyResetScopeCoverage();
    await loadSessionsOnBoot();

    // Expire stale sessions and throttle records hourly
    setInterval(() => { void sweepSessions(); }, 60 * 60 * 1000);

    // Initialize TUI
    tui.init();

    // Emitted after the TUI is up so it is actually rendered, and mirrored to
    // stderr so it survives in container logs regardless of the TUI.
    if (isWeakPassword(ADMIN_PASSWORD)) {
        const warning = `SECURITY: ADMIN_PASSWORD is still the default ("${ADMIN_PASSWORD}"). Anyone who can reach this server can administer it — set ADMIN_PASSWORD to something private.`;
        emitLog(warning, 'warning');
        console.warn(`[Auth] ${warning}`);
    }

    // Catch-all 404 for unhandled API/File requests
    app.use((req: express.Request, res: express.Response) => {
        res.status(404).json({ error: 'Not found' });
    });

    httpServer = app.listen(PORT, () => {
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

// ── Graceful shutdown ─────────────────────────
let httpServer: import('http').Server | null = null;
let shutdownInProgress = false;

/** Upper bound on the whole drain; SIGKILL follows if we exceed it. */
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '30000', 10);
const RECORDING_DRAIN_MS = Math.max(1000, SHUTDOWN_GRACE_MS - 8000);

/**
 * Stop accepting work, let in-flight recordings finalise, then exit.
 *
 * ffmpeg writes a playable MP4 when it receives SIGINT, so draining turns what
 * used to be a salvage job on next boot into an ordinary completed recording.
 */
async function shutdown(signal: string): Promise<void> {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    // Last resort: never hang a container stop.
    const forceExit = setTimeout(() => {
        console.error(`[Shutdown] Grace period of ${SHUTDOWN_GRACE_MS}ms exceeded; forcing exit.`);
        process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
        // 1. Stop taking on new work
        stopRecordingScheduler();
        if (activePipeline) {
            activePipeline.cancel();
        }

        // 2. Stop serving; in-flight requests are allowed to finish
        if (httpServer) {
            await new Promise<void>(resolve => httpServer!.close(() => resolve()));
            console.log('[Shutdown] HTTP server closed.');
        }

        // 3. Finalise recordings — the part that actually matters
        await drainRecordings(RECORDING_DRAIN_MS);

        // 4. Kill transcodes and release their scratch directories
        StreamManager.stopAll();

        // 5. Close the database last, once nothing else can write
        try {
            db.close();
            console.log('[Shutdown] Database closed.');
        } catch (e: any) {
            console.error('[Shutdown] Error closing database:', e.message);
        }
    } catch (e: any) {
        console.error('[Shutdown] Error during graceful shutdown:', e.message);
    }

    clearTimeout(forceExit);
    console.log('[Shutdown] Complete.');
    process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

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

// Favourites and hidden channels are viewer-scope display preferences, not
// system configuration. Reads were already public; the writes required an admin
// token and failed silently for anyone watching, so the state quietly diverged
// per device. Both directions are now viewer scope.

// POST /api/channels/favorites - Add channel to favorites
app.post('/api/channels/favorites', async (req: any, res: any) => {
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
app.delete('/api/channels/favorites/:id', async (req: any, res: any) => {
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
app.post('/api/channels/hidden', async (req: any, res: any) => {
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
app.delete('/api/channels/hidden/:id', async (req: any, res: any) => {
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
        
        const FAST_PRESETS = [
            { name: 'Pluto TV (All Channels)', url: 'https://i.mjh.nz/PlutoTV/all.m3u8', category: 'fast', provider: 'plutotv', label: 'Pluto TV', channelCountEstimate: 350 },
            { name: 'Samsung TV Plus (All Channels)', url: 'https://i.mjh.nz/SamsungTVPlus/all.m3u8', category: 'fast', provider: 'samsung', label: 'Samsung TV Plus', channelCountEstimate: 280 },
            { name: 'Roku Channel (All Channels)', url: 'https://i.mjh.nz/Roku/all.m3u8', category: 'fast', provider: 'roku', label: 'Roku Channel', channelCountEstimate: 300 },
            { name: 'Plex TV (All Channels)', url: 'https://i.mjh.nz/Plex/all.m3u8', category: 'fast', provider: 'plex', label: 'Plex TV', channelCountEstimate: 250 },
            { name: 'PBS (All Channels)', url: 'https://i.mjh.nz/PBS/all.m3u8', category: 'fast', provider: 'pbs', label: 'PBS', channelCountEstimate: 120 },
            { name: 'Stirr TV (All Channels)', url: 'https://i.mjh.nz/Stirr/all.m3u8', category: 'fast', provider: 'stirr', label: 'Stirr TV', channelCountEstimate: 100 }
        ];

        const playlists: any[] = FAST_PRESETS.map(preset => ({
            ...describePlaylist(preset.url),
            ...preset
        }));
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
        const {
            channel_id,
            channel_name,
            program_title,
            start_time,
            end_time,
            stream_url,
            thumbnail,
            sub_title,
            episode_num,
            description,
            rating,
            category,
            record_series
        } = req.body;

        if (!channel_id) {
            return res.status(400).json({ error: 'Channel ID is required' });
        }

        // Validate channel exists and is enabled
        const chanCheck = await db.execute({
            sql: 'SELECT enabled, name, url FROM channels WHERE id = ?',
            args: [channel_id],
        });
        if (chanCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        if (chanCheck.rows[0].enabled === 0) {
            return res.status(400).json({ error: 'Cannot schedule recording on a disabled channel' });
        }

        // Tell the user now, rather than letting the recording fail at start time
        const retention = await getRetentionPolicy();
        const freeBytes = getFreeSpaceBytes();
        if (!meetsFreeSpaceFloor(freeBytes, retention.minFreeBytes)) {
            return res.status(507).json({
                code: 'INSUFFICIENT_STORAGE',
                error: `Not enough free space to record: ${formatBytes(freeBytes)} available, ${formatBytes(retention.minFreeBytes)} required. Delete some recordings and try again.`
            });
        }

        const resolvedChannelName = channel_name || (chanCheck.rows[0].name as string);
        const resolvedStreamUrl = stream_url || (chanCheck.rows[0].url as string);

        // Check for existing duplicate schedule on same channel and overlapping start time
        const existing = await db.execute({
            sql: `SELECT id FROM scheduled_recordings
                  WHERE channel_id = ? AND program_title = ? AND start_time = ? AND status != 'failed'`,
            args: [channel_id, program_title, start_time],
        });
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'A recording for this program is already scheduled' });
        }

        await db.execute({
            sql: `INSERT INTO scheduled_recordings (
                    channel_id, channel_name, program_title, start_time, end_time, stream_url,
                    thumbnail, sub_title, episode_num, description, rating, category, status
                  )
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
            args: [
                channel_id,
                resolvedChannelName,
                program_title,
                start_time,
                end_time,
                resolvedStreamUrl,
                thumbnail || null,
                sub_title || null,
                episode_num || null,
                description || null,
                rating || null,
                category || null
            ]
        });

        // Save series rule if requested
        if (record_series && program_title) {
            await db.execute({
                sql: `INSERT OR IGNORE INTO dvr_series_rules (channel_id, series_title) VALUES (?, ?)`,
                args: [channel_id, program_title],
            });
        }

        // Check if we need to start it immediately (scheduler checks every 30s)
        checkScheduledRecordings();

        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/recordings/system - Public read-only DVR listing for the watch UI
app.get('/api/recordings/system', async (req: any, res: any) => {
    try {
        const result = await db.execute(`
            SELECT
                sr.*,
                c.name as channel_fallback_name,
                c.tvg_logo as channel_logo,
                ep.icon as program_icon
            FROM scheduled_recordings sr
            LEFT JOIN channels c ON c.id = sr.channel_id
            LEFT JOIN manual_overrides mo ON mo.channel_id = sr.channel_id
            LEFT JOIN epg_programs ep
                ON ep.channel_id = COALESCE(mo.epg_id, c.matched_epg_id)
                AND ep.title = sr.program_title
                AND ep.start = strftime('%Y%m%d%H%M%S', sr.start_time) || ' +0000'
            ORDER BY sr.start_time DESC
        `);
        res.json(result.rows.map((row: any) => mapSystemRecordingRow(row)));
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Stream completed DVR recording file for in-browser playback
app.get('/api/dvr/stream/:filename', async (req: any, res: any) => {
    try {
        const filePath = safeRecordingPath(req.params.filename);
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid recording filename' });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).send('Recording file not found');
        }
        res.sendFile(filePath);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ── Series Rules API ──
app.get('/api/dvr/series-rules', requireAuth, async (req: any, res: any) => {
    try {
        const result = await db.execute(`
            SELECT r.*, c.name as channel_name
            FROM dvr_series_rules r
            LEFT JOIN channels c ON c.id = r.channel_id
            ORDER BY r.created_at DESC
        `);
        res.json(result.rows);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/dvr/series-rules/:id', requireAuth, async (req: any, res: any) => {
    try {
        const id = parseInt(req.params.id);
        await db.execute({
            sql: 'DELETE FROM dvr_series_rules WHERE id = ?',
            args: [id],
        });
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

// GET /api/dvr/storage - Volume usage, plus the share taken by recordings
app.get('/api/dvr/storage', requireAuth, async (req: any, res: any) => {
    try {
        const recordingsDir = path.join(DB_DIR, 'recordings');
        let recordingsBytes = 0;
        if (fs.existsSync(recordingsDir)) {
            const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.mp4') || f.includes('.part'));
            for (const f of files) {
                try {
                    recordingsBytes += fs.statSync(path.join(recordingsDir, f)).size;
                } catch (_) {}
            }
        }

        // usedBytes/totalBytes describe the volume, so the gauge reflects real
        // disk pressure rather than the recordings folder in isolation.
        const { totalBytes, freeBytes, usedBytes } = getVolumeUsage();
        const policy = await getRetentionPolicy();

        res.json({
            usedBytes,
            totalBytes,
            freeBytes,
            recordingsBytes,
            retention: {
                mode: policy.mode,
                maxAgeDays: policy.maxAgeDays,
                minFreeBytes: policy.minFreeBytes
            }
        });
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

// DELETE /api/recordings/:filename - Delete a recording
app.delete('/api/recordings/:filename', requireAuth, async (req: any, res: any) => {
    try {
        const filePath = safeRecordingPath(req.params.filename);
        if (!filePath) {
            return res.status(400).json({ error: "Invalid recording filename" });
        }
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

        // Search enabled grab-capable EPG source channels.
        const result = await db.execute({
            sql: `SELECT esc.xmltv_id as id, esc.name as display_name, esc.site, esc.source_key
                  FROM epg_source_channels esc
                  JOIN sources es ON es.key = esc.source_key
                  WHERE es.enabled = 1
                  AND es.grab_capable = 1
                  AND (esc.name LIKE ? OR esc.xmltv_id LIKE ?)
                  GROUP BY esc.xmltv_id, esc.name, esc.site, esc.source_key
                  ORDER BY es.priority DESC, COALESCE(es.channel_count_estimate, 0) DESC, esc.name
                  LIMIT 50`,
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
c.id, c.name, c.group_title, c.url, c.tvg_id, c.tvg_logo, c.channel_number,
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
        const displayRows = dedupeChannelsForDisplay(channelsRes.rows as any[]);

        // Collect all EPG IDs to fetch programs in one query
        const epgIds = displayRows
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
        const channels = displayRows.map(c => {
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
        // Capacity is a temporary condition the client can retry, not a server fault
        if (e?.code === 'STREAM_LIMIT') {
            return res.status(503).json({ error: e.message, code: e.code });
        }
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
