import './patch-axios';
import { db, DB_DIR } from '../db';
import { fork } from 'child_process';
import { emitLog, emitProgress, emitProgressComplete } from '../events';
import * as fs from 'fs';
import * as path from 'path';
import { EPGGrabber, Channel as GrabberChannel } from 'epg-grabber';
import merge from 'lodash.merge';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { pathToFileURL } from 'url';
import { formatMemorySnapshot } from './memory';
import { getGrabBatchSizeForSite, prioritizeGrabSites } from './pipeline-utils';

dayjs.extend(utc);

const REPO_DIR = path.join(DB_DIR, 'iptv-org-epg');
const MAX_FAILURES_BEFORE_SKIP = 3; // Skip site after 3 consecutive failures
const RETRY_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours
const MAX_CHANNEL_FAILURES_BEFORE_DISABLE = 5; // Auto-disable channel after 5 consecutive failures

interface ChannelSiteInfo {
    xmltv_id: string;
    sites: Array<{ site: string; site_id: string; lang: string }>;
}

interface SkipInfo {
    shouldSkip: boolean;
    failureCount: number;
    retryInMin: number;
}

async function shouldSkipSiteInfo(site: string): Promise<SkipInfo> {
    const result = await db.execute({
        sql: "SELECT last_attempt, last_success, failure_count FROM site_status WHERE site = ?",
        args: [site]
    });

    if (result.rows.length === 0) {
        return { shouldSkip: false, failureCount: 0, retryInMin: 0 };
    }

    const row = result.rows[0];
    const failureCount = Number(row.failure_count) || 0;
    const lastAttempt = Number(row.last_attempt) || 0;
    const now = Date.now();

    if (failureCount >= MAX_FAILURES_BEFORE_SKIP) {
        const timeSinceLastAttempt = now - lastAttempt;
        if (timeSinceLastAttempt < RETRY_INTERVAL_MS) {
            const retryInMin = Math.ceil((RETRY_INTERVAL_MS - timeSinceLastAttempt) / 60000);
            return { shouldSkip: true, failureCount, retryInMin };
        }
    }

    return { shouldSkip: false, failureCount, retryInMin: 0 };
}

async function shouldSkipSite(site: string): Promise<boolean> {
    const info = await shouldSkipSiteInfo(site);
    return info.shouldSkip;
}

async function recordSiteAttempt(site: string, success: boolean) {
    const now = Date.now();

    if (success) {
        await db.execute({
            sql: `INSERT INTO site_status (site, last_attempt, last_success, failure_count) 
                  VALUES (?, ?, ?, 0)
                  ON CONFLICT(site) DO UPDATE SET 
                  last_attempt = ?, last_success = ?, failure_count = 0`,
            args: [site, now, now, now, now]
        });
    } else {
        await db.execute({
            sql: `INSERT INTO site_status (site, last_attempt, failure_count) 
                  VALUES (?, ?, 1)
                  ON CONFLICT(site) DO UPDATE SET 
                  last_attempt = ?, failure_count = failure_count + 1`,
            args: [site, now, now]
        });
    }
}

/**
 * Track channel-level grab results and auto-disable channels with consistent failures.
 * Returns true if the channel was auto-disabled.
 */
async function recordChannelGrabResult(xmltvId: string, success: boolean): Promise<boolean> {
    const now = Date.now();

    if (success) {
        // Reset failure count on success
        await db.execute({
            sql: `INSERT INTO channel_grab_status (xmltv_id, consecutive_failures, last_success, auto_disabled) 
                  VALUES (?, 0, ?, 0)
                  ON CONFLICT(xmltv_id) DO UPDATE SET 
                  consecutive_failures = 0, last_success = ?, auto_disabled = 0`,
            args: [xmltvId, now, now]
        });
        return false;
    }

    // Record failure and get updated count
    await db.execute({
        sql: `INSERT INTO channel_grab_status (xmltv_id, consecutive_failures, last_failure) 
              VALUES (?, 1, ?)
              ON CONFLICT(xmltv_id) DO UPDATE SET 
              consecutive_failures = consecutive_failures + 1, last_failure = ?`,
        args: [xmltvId, now, now]
    });

    // Check if threshold exceeded
    const result = await db.execute({
        sql: `SELECT consecutive_failures FROM channel_grab_status WHERE xmltv_id = ?`,
        args: [xmltvId]
    });

    const failures = Number(result.rows[0]?.consecutive_failures || 0);

    if (failures >= MAX_CHANNEL_FAILURES_BEFORE_DISABLE) {
        // Auto-disable in channels table and mark in status
        await db.execute({
            sql: `UPDATE channels SET enabled = 0 WHERE matched_epg_id = ? OR id IN (
                SELECT channel_id FROM manual_overrides WHERE epg_id = ?
            )`,
            args: [xmltvId, xmltvId]
        });
        await db.execute({
            sql: `UPDATE channel_grab_status SET auto_disabled = 1 WHERE xmltv_id = ?`,
            args: [xmltvId]
        });
        emitLog(`Channel ${xmltvId} auto-disabled after ${failures} consecutive failures`, 'warning');
        return true;
    }

    return false;
}

async function recordChannelSiteResult(xmltvId: string, site: string, success: boolean, programCount: number): Promise<void> {
    const now = Date.now();
    try {
        if (success) {
            await db.execute({
                sql: `INSERT INTO channel_site_status (xmltv_id, site, success_count, failure_count, last_program_count, last_attempt)
                      VALUES (?, ?, 1, 0, ?, ?)
                      ON CONFLICT(xmltv_id, site) DO UPDATE SET
                      success_count = success_count + 1,
                      last_program_count = ?,
                      last_attempt = ?`,
                args: [xmltvId, site, programCount, now, programCount, now]
            });
        } else {
            await db.execute({
                sql: `INSERT INTO channel_site_status (xmltv_id, site, success_count, failure_count, last_program_count, last_attempt)
                      VALUES (?, ?, 0, 1, 0, ?)
                      ON CONFLICT(xmltv_id, site) DO UPDATE SET
                      failure_count = failure_count + 1,
                      last_attempt = ?`,
                args: [xmltvId, site, now, now]
            });
        }
    } catch (e: any) {
        console.error('Failed to record channel site result:', e.message);
    }
}

/**
 * Get list of auto-disabled channels
 */
export async function getAutoDisabledChannels(): Promise<any[]> {
    const result = await db.execute(`
        SELECT cgs.*, c.name, c.group_title
        FROM channel_grab_status cgs
        LEFT JOIN channels c ON c.matched_epg_id = cgs.xmltv_id
        WHERE cgs.auto_disabled = 1
    `);
    return result.rows;
}

/**
 * Re-enable auto-disabled channels
 */
export async function reEnableChannels(xmltvIds: string[]): Promise<number> {
    for (const xmltvId of xmltvIds) {
        await db.execute({
            sql: `UPDATE channel_grab_status SET consecutive_failures = 0, auto_disabled = 0 WHERE xmltv_id = ?`,
            args: [xmltvId]
        });
        await db.execute({
            sql: `UPDATE channels SET enabled = 1 WHERE matched_epg_id = ?`,
            args: [xmltvId]
        });
    }
    return xmltvIds.length;
}

export async function grabMissingChannels(xmltvIds: string[], force = false) {
    if (xmltvIds.length === 0) return;

    // Get epg_days from settings
    const daysResult = await db.execute("SELECT value FROM settings WHERE key = 'epg_days'");
    const epgDays = daysResult.rows.length > 0 ? String(daysResult.rows[0].value) : '2';

    emitLog(`Starting failover EPG grab for ${xmltvIds.length} channels (${epgDays} days)...`, "info");
    emitLog(formatMemorySnapshot('grab missing start', process.memoryUsage(), { channels: xmltvIds.length, epgDays, force }), 'info');
    emitProgress(`Mapping sites for EPG grab...`, 0, xmltvIds.length, 'grab');

    // Fetch ALL available sites for each channel (no GROUP BY)
    const channelSites = new Map<string, { site: string; site_id: string; lang: string }[]>();
    
    // Process in chunks to avoid SQLite limits
    const chunkSize = 500;
    for (let i = 0; i < xmltvIds.length; i += chunkSize) {
        const chunk = xmltvIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const res = await db.execute({
            sql: `
                SELECT esc.xmltv_id, esc.site, esc.site_id, esc.lang
                FROM epg_source_channels esc
                JOIN epg_sources es ON es.key = esc.source_key
                WHERE esc.xmltv_id IN (${placeholders})
                AND es.enabled = 1
                AND es.grab_capable = 1
                AND esc.site IS NOT NULL
                AND esc.site_id IS NOT NULL
            `,
            args: chunk
        });
        
        const seenSiteRows = new Set<string>();
        for (let row of res.rows) {
            const xmltvId = String(row.xmltv_id);
            const siteKey = `${xmltvId}|${row.site}|${row.site_id}`;
            if (seenSiteRows.has(siteKey)) continue;
            seenSiteRows.add(siteKey);
            if (!channelSites.has(xmltvId)) channelSites.set(xmltvId, []);
            channelSites.get(xmltvId)!.push({
                site: String(row.site),
                site_id: String(row.site_id),
                lang: String(row.lang || 'en')
            });
        }
    }

    // Load channel site performance stats to rank sites
    const statsRes = await db.execute("SELECT xmltv_id, site, success_count, failure_count, last_program_count FROM channel_site_status");
    const statsMap = new Map<string, { success_count: number; failure_count: number; last_program_count: number }>();
    for (const r of statsRes.rows) {
        statsMap.set(`${r.xmltv_id}|${r.site}`, {
            success_count: Number(r.success_count) || 0,
            failure_count: Number(r.failure_count) || 0,
            last_program_count: Number(r.last_program_count) || 0
        });
    }

    // Rank available sites for each channel
    for (const [xmltvId, sites] of channelSites.entries()) {
        const ranked = [...sites].sort((a, b) => {
            const statsA = statsMap.get(`${xmltvId}|${a.site}`) || { success_count: 0, failure_count: 0, last_program_count: 0 };
            const statsB = statsMap.get(`${xmltvId}|${b.site}`) || { success_count: 0, failure_count: 0, last_program_count: 0 };

            const totalA = statsA.success_count + statsA.failure_count;
            const totalB = statsB.success_count + statsB.failure_count;

            const rateA = totalA > 0 ? statsA.success_count / totalA : 0.5;
            const rateB = totalB > 0 ? statsB.success_count / totalB : 0.5;

            if (rateA !== rateB) return rateB - rateA;
            if (statsA.last_program_count !== statsB.last_program_count) return statsB.last_program_count - statsA.last_program_count;
            return 0;
        });
        channelSites.set(xmltvId, ranked);
    }

    const grabbedSuccessful = new Set<string>();
    const channelSiteAttempts = new Map<string, number>(); // Tracks the index of the site to try next
    
    let round = 1;
    const MAX_ROUNDS = 3;
    let completedCount = 0;
    let successfulCount = 0;
    let failedCount = 0;

    const CONCURRENCY_LIMIT = 2;

    emitProgress(`Grabbing EPG: 0/${xmltvIds.length}`, 0, xmltvIds.length, 'grab');

    while (round <= MAX_ROUNDS) {
        // Step 1: Assign active/remaining channels to their next best site
        const siteMap = new Map<string, { xmltvId: string; site_id: string; lang: string }[]>();
        let activeChannelsInRound = 0;

        for (const xmltvId of xmltvIds) {
            if (grabbedSuccessful.has(xmltvId)) continue;

            const sites = channelSites.get(xmltvId) || [];
            const attemptIdx = channelSiteAttempts.get(xmltvId) || 0;

            if (attemptIdx < sites.length) {
                const siteInfo = sites[attemptIdx];
                if (!siteMap.has(siteInfo.site)) siteMap.set(siteInfo.site, []);
                siteMap.get(siteInfo.site)!.push({
                    xmltvId,
                    site_id: siteInfo.site_id,
                    lang: siteInfo.lang
                });
                activeChannelsInRound++;
            }
        }

        if (activeChannelsInRound === 0) {
            emitLog(`No active channels remaining to grab in round ${round}. Ending grab process.`, 'info');
            break;
        }

        emitLog(`[Failover] Starting Grab Round ${round}. Queueing ${activeChannelsInRound} channels across ${siteMap.size} sites.`, 'info');

        const activePromises = new Set<Promise<void>>();
        const orderedSites = prioritizeGrabSites(Array.from(siteMap.keys()));
        const siteEntries = orderedSites.map((site) => [site, siteMap.get(site)!] as [string, { xmltvId: string; site_id: string; lang: string }[]]);
        let index = 0;

        while (index < siteEntries.length || activePromises.size > 0) {
            while (activePromises.size < CONCURRENCY_LIMIT && index < siteEntries.length) {
                const [site, channels] = siteEntries[index++];
                const BATCH_SIZE = getGrabBatchSizeForSite(site);

                for (let j = 0; j < channels.length; j += BATCH_SIZE) {
                    const batch = channels.slice(j, j + BATCH_SIZE);
                    const p = grabSiteBatch(site, batch, epgDays, force).then(results => {
                        for (const res of results) {
                            // Increment attempt count for this channel
                            const currentAttempt = channelSiteAttempts.get(res.xmltvId) || 0;
                            channelSiteAttempts.set(res.xmltvId, currentAttempt + 1);

                            if (res.success) {
                                if (!grabbedSuccessful.has(res.xmltvId)) {
                                    grabbedSuccessful.add(res.xmltvId);
                                    successfulCount++;
                                    completedCount++;
                                }
                            }
                        }
                        emitProgress(`Grabbing: ${completedCount}/${xmltvIds.length} (${successfulCount} ok)`, completedCount, xmltvIds.length, 'grab');
                    }).catch(err => {
                        emitLog(`Batch grab for site ${site} failed: ${err.message}`, 'warning');
                        // Increment attempt count for all channels in the failed batch
                        for (const c of batch) {
                            const currentAttempt = channelSiteAttempts.get(c.xmltvId) || 0;
                            channelSiteAttempts.set(c.xmltvId, currentAttempt + 1);
                        }
                    });

                    activePromises.add(p);
                    p.finally(() => activePromises.delete(p));
                }
            }
            if (activePromises.size > 0) {
                await Promise.race(activePromises);
            }
        }

        round++;
    }

    // Identify final failed channels (those not in grabbedSuccessful)
    const finalFailed = xmltvIds.filter(id => !grabbedSuccessful.has(id));
    failedCount = finalFailed.length;

    // Hint GC to reclaim site config modules and XML parse buffers
    if (global.gc) { try { global.gc(); } catch (_) {} }

    emitLog(formatMemorySnapshot('grab missing complete', process.memoryUsage(), { successful: successfulCount, failed: failedCount, sites: channelSites.size }), 'info');
    emitLog(`EPG grab complete: ${successfulCount} ok, ${failedCount} failed.`, "success");
    emitProgressComplete('grab', `Complete: ${successfulCount} ok, ${failedCount} failed`, xmltvIds.length);
}

const defaultConfig = {
  output: 'guide.xml',
  days: 1,
  delay: 0,
  maxConnections: 1,
  curl: false,
  gzip: false,
  json: false,
  debug: false,
  request: {
    maxContentLength: 5242880,
    timeout: 30000,
    withCredentials: true,
    jar: null,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    cache: {
      ttl: 24 * 60 * 60 * 1000 // 24 hours
    }
  }
};

export interface BatchGrabResult {
    xmltvId: string;
    success: boolean;
}

export const activeGrabProcesses = new Set<any>();

export function cancelAllGrabProcesses() {
    for (const child of activeGrabProcesses) {
        try {
            child.kill('SIGKILL');
        } catch (_) {}
    }
    activeGrabProcesses.clear();
}

/**
 * Grabs EPG data for an entire batch of channels that share the same site.
 */
export async function grabSiteBatch(
    site: string, 
    channels: { xmltvId: string; site_id: string; lang: string }[], 
    epgDays: string,
    force = false
): Promise<BatchGrabResult[]> {
    return new Promise((resolve, reject) => {
        const isTsNode = __filename.endsWith('.ts');
        const workerPath = isTsNode 
          ? path.join(__dirname, 'grab-worker.ts') 
          : path.join(__dirname, 'grab-worker.js');

        const execArgv = isTsNode 
          ? ['-r', 'ts-node/register', '--max-old-space-size=4096'] 
          : ['--max-old-space-size=4096'];

        const child = fork(
            workerPath,
            ['batch', site, JSON.stringify(channels), epgDays, String(force)],
            { execArgv }
        );

        activeGrabProcesses.add(child);

        let resolved = false;

        const cleanUp = () => {
            activeGrabProcesses.delete(child);
        };

        const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes timeout
        const timeoutTimer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanUp();
                emitLog(`Grab worker for site ${site} timed out after ${TIMEOUT_MS / 60000} minutes. Killing process.`, 'error');
                child.kill('SIGKILL');
                reject(new Error(`Grab worker for site ${site} timed out`));
            }
        }, TIMEOUT_MS);

        child.on('message', (msg: any) => {
            clearTimeout(timeoutTimer);
            cleanUp();
            if (msg.success) {
                resolved = true;
                resolve(msg.results);
            } else {
                resolved = true;
                reject(new Error(msg.error || 'Worker batch grab failed'));
            }
        });

        child.on('exit', (code) => {
            clearTimeout(timeoutTimer);
            cleanUp();
            if (!resolved) {
                reject(new Error(`Grab worker for site ${site} exited with code ${code}`));
            }
        });

        child.on('error', (err) => {
            clearTimeout(timeoutTimer);
            cleanUp();
            if (!resolved) {
                resolved = true;
                reject(err);
            }
        });
    });
}

/**
 * Grabs EPG data for an entire batch of channels that share the same site.
 */
export async function grabSiteBatchInProcess(
    site: string, 
    channels: { xmltvId: string; site_id: string; lang: string }[], 
    epgDays: string,
    force = false
): Promise<BatchGrabResult[]> {
    const results: BatchGrabResult[] = channels.map(c => ({ xmltvId: c.xmltvId, success: false }));
    const startTime = Date.now();
    emitLog(formatMemorySnapshot('site batch start', process.memoryUsage(), { site, batch: channels.length, epgDays, force }), 'info');
    
    if (force) {
        // Clear site failure status if forced
        await db.execute({
            sql: "DELETE FROM site_status WHERE site = ?",
            args: [site]
        });
    } else {
        const skipInfo = await shouldSkipSiteInfo(site);
        if (skipInfo.shouldSkip) {
            const duration = Date.now() - startTime;
            for (let res of results) {
                await recordGrabLog(res.xmltvId, site, false, `Site skipped due to ${skipInfo.failureCount} recent consecutive failures`, 0, duration);
            }
            emitLog(`Site ${site} skipped due to ${skipInfo.failureCount} recent consecutive failures. Will retry in ${skipInfo.retryInMin} minutes.`, "warning");
            return results;
        }
    }

    try {
        const configPath = path.join(REPO_DIR, 'sites', site, `${site}.config.js`);
        if (!fs.existsSync(configPath)) {
            throw new Error(`Site config not found: ${configPath}`);
        }
        
        // Dynamically load site config
        const configUrl = pathToFileURL(configPath).toString();
        const configModule = await import(configUrl);
        const siteConfig = configModule.default || configModule;
        const config = merge({}, defaultConfig, siteConfig);
        
        // Ensure maxConnections and timeout from environment or options can override
        if (process.env.TIMEOUT) {
            config.request.timeout = parseInt(process.env.TIMEOUT, 10);
        }
        if (process.env.DELAY) {
            config.delay = parseInt(process.env.DELAY, 10);
        }

        const grabber = new EPGGrabber(config);
        const days = parseInt(epgDays, 10) || 1;
        const currDate = dayjs.utc();
        const dates = Array.from({ length: days }, (_, day) => currDate.add(day, 'd'));

        const xmltvIds = channels.map(c => c.xmltvId);
        
        // Delete existing programs for these channels from iptv-org source
        for (let i = 0; i < xmltvIds.length; i += 200) {
            const chunk = xmltvIds.slice(i, i + 200);
            await db.execute({
                sql: `DELETE FROM epg_programs WHERE channel_id IN (${chunk.map(() => '?').join(',')}) AND source LIKE '%iptv-org%'`,
                args: chunk
            });
        }

        const programCounts: Record<string, number> = {};
        let anySuccess = false;

        for (const c of channels) {
            const grabberChannel = new GrabberChannel({
                site: site,
                site_id: c.site_id,
                xmltv_id: c.xmltvId,
                lang: c.lang,
                name: c.xmltvId,
                logo: '',
                url: '',
                lcn: '',
                index: 0
            });

            let totalForChannel = 0;

            // Flush each day's programs to DB immediately — never accumulate
            // all days in memory at once, which caused heap OOM on large sites.
            for (const date of dates) {
                let datePrograms: any[] = [];
                try {
                    datePrograms = await grabber.grab(grabberChannel, date, config) || [];
                } catch (err: any) {
                    emitLog(`Failed to grab ${c.xmltvId} for date ${date.format('YYYY-MM-DD')}: ${err.message}`, "warning");
                }

                if (datePrograms.length > 0) {
                    const batchArgs: any[] = [];
                    for (const prog of datePrograms) {
                        batchArgs.push([
                            c.xmltvId,
                            `iptv-org:${site}`,
                            dayjs(prog.start).utc().format('YYYYMMDDHHmmss ZZ'),
                            dayjs(prog.stop).utc().format('YYYYMMDDHHmmss ZZ'),
                            prog.titles?.[0]?.value || '',
                            prog.descriptions?.[0]?.value || '',
                            prog.subTitles?.[0]?.value || '',
                            prog.episodeNumbers?.[0]?.value || '',
                            prog.categories?.map((cat: any) => cat.value).join(', ') || '',
                            prog.ratings?.[0]?.value || '',
                            prog.icons?.[0]?.src || ''
                        ]);
                    }
                    // Flush this day's data to DB immediately and let GC reclaim it
                    const placeholders = batchArgs.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
                    await db.execute('BEGIN TRANSACTION');
                    await db.execute({
                        sql: `INSERT INTO epg_programs (channel_id, source, start, stop, title, desc, sub_title, episode_num, category, rating, icon) VALUES ${placeholders}`,
                        args: batchArgs.flat()
                    });
                    await db.execute('COMMIT');
                    totalForChannel += datePrograms.length;
                    // Allow datePrograms to be GC'd before next iteration
                    datePrograms = [];
                }
            }

            if (totalForChannel > 0) {
                programCounts[c.xmltvId] = totalForChannel;
                anySuccess = true;
            }
            // Small delay between channels to let GC reclaim parse buffers
            // and avoid hammering upstream servers
            await new Promise(r => setTimeout(r, 100));
        }

        const duration = Date.now() - startTime;
        for (let res of results) {
            const count = programCounts[res.xmltvId] || 0;
            if (count > 0) {
                res.success = true;
                await recordGrabLog(res.xmltvId, site, true, `Loaded ${count} programs in-process`, count, duration);
                await recordChannelGrabResult(res.xmltvId, true);
                await recordChannelSiteResult(res.xmltvId, site, true, count);
            } else {
                await recordGrabLog(res.xmltvId, site, false, `Site returned 0 programs in-process`, 0, duration);
                await recordChannelGrabResult(res.xmltvId, false);
                await recordChannelSiteResult(res.xmltvId, site, false, 0);
            }
        }
        
        await recordSiteAttempt(site, anySuccess);
        emitLog(formatMemorySnapshot('site batch complete', process.memoryUsage(), { site, batch: channels.length, anySuccess }), 'info');
        return results;

    } catch (e: any) {
        await recordSiteAttempt(site, false);
        emitLog(formatMemorySnapshot('site batch failed', process.memoryUsage(), { site, batch: channels.length, error: e.message }), 'warning');
        const duration = Date.now() - startTime;
        for (let res of results) {
            await recordGrabLog(res.xmltvId, site, false, e.message, 0, duration);
            await recordChannelGrabResult(res.xmltvId, false);
            await recordChannelSiteResult(res.xmltvId, site, false, 0);
        }
    }

    return results;
}

/**
 * Grab EPG data for a single channel. Used by the streaming pipeline queue.
 * Does not emit overarching progress events.
 * Returns true if successful, false if all sites failed.
 */
export async function grabChannel(xmltvId: string, epgDays: string, force = false): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const isTsNode = __filename.endsWith('.ts');
        const workerPath = isTsNode 
          ? path.join(__dirname, 'grab-worker.ts') 
          : path.join(__dirname, 'grab-worker.js');

        const execArgv = isTsNode 
          ? ['-r', 'ts-node/register', '--max-old-space-size=4096'] 
          : ['--max-old-space-size=4096'];

        const child = fork(
            workerPath,
            ['channel', xmltvId, '', epgDays, String(force)],
            { execArgv }
        );

        let resolved = false;

        const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes timeout for single channel
        const timeoutTimer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                emitLog(`Grab worker for channel ${xmltvId} timed out after ${TIMEOUT_MS / 60000} minutes. Killing process.`, 'error');
                child.kill('SIGKILL');
                reject(new Error(`Grab worker for channel ${xmltvId} timed out`));
            }
        }, TIMEOUT_MS);

        child.on('message', (msg: any) => {
            clearTimeout(timeoutTimer);
            if (msg.success) {
                resolved = true;
                resolve(msg.results);
            } else {
                resolved = true;
                reject(new Error(msg.error || 'Worker channel grab failed'));
            }
        });

        child.on('exit', (code) => {
            clearTimeout(timeoutTimer);
            if (!resolved) {
                reject(new Error(`Grab worker for channel ${xmltvId} exited with code ${code}`));
            }
        });

        child.on('error', (err) => {
            clearTimeout(timeoutTimer);
            if (!resolved) {
                resolved = true;
                reject(err);
            }
        });
    });
}

/**
 * Grab EPG data for a single channel. Used by the streaming pipeline queue.
 * Does not emit overarching progress events.
 * Returns true if successful, false if all sites failed.
 */
export async function grabChannelInProcess(xmltvId: string, epgDays: string, force = false): Promise<boolean> {
    const res = await db.execute({
        sql: `
            SELECT m.xmltv_id, m.site, m.site_id, m.lang
            FROM epg_source_channels m
            JOIN epg_sources es ON es.key = m.source_key
            WHERE m.xmltv_id = ?
            AND es.enabled = 1
            AND es.grab_capable = 1
            AND m.site IS NOT NULL
            AND m.site_id IS NOT NULL
            ORDER BY es.priority DESC, COALESCE(es.channel_count_estimate, 0) DESC, m.site
        `,
        args: [xmltvId]
    });

    if (res.rows.length === 0) {
        return false;
    }

    const sites: { site: string; site_id: string; lang: string }[] = [];
    const seenSites = new Set<string>();
    for (const row of res.rows) {
        const key = `${row.site}|${row.site_id}`;
        if (seenSites.has(key)) continue;
        seenSites.add(key);
        sites.push({
            site: String(row.site),
            site_id: String(row.site_id),
            lang: String(row.lang || 'en')
        });
    }

    const startTime = Date.now();
    let lastError = '';

    for (const siteInfo of sites) {
        const { site, site_id, lang } = siteInfo;

        if (force) {
            await db.execute({
                sql: "DELETE FROM site_status WHERE site = ?",
                args: [site]
            });
        } else if (await shouldSkipSite(site)) {
            continue;
        }

        try {
            const configPath = path.join(REPO_DIR, 'sites', site, `${site}.config.js`);
            if (!fs.existsSync(configPath)) {
                continue;
            }

            const configUrl = pathToFileURL(configPath).toString();
            const configModule = await import(configUrl);
            const siteConfig = configModule.default || configModule;
            const config = merge({}, defaultConfig, siteConfig);

            const grabber = new EPGGrabber(config);
            const days = parseInt(epgDays, 10) || 1;
            const currDate = dayjs.utc();
            const dates = Array.from({ length: days }, (_, day) => currDate.add(day, 'd'));

            const grabberChannel = new GrabberChannel({
                site: site,
                site_id: site_id,
                xmltv_id: xmltvId,
                lang: lang,
                name: xmltvId,
                logo: '',
                url: '',
                lcn: '',
                index: 0
            });

            let totalForChannel = 0;

            // Delete existing programs before writing new ones
            await db.execute({
                sql: `DELETE FROM epg_programs WHERE channel_id = ? AND source LIKE '%iptv-org%'`,
                args: [xmltvId]
            });

            // Flush each day immediately — do not accumulate all days in memory
            for (const date of dates) {
                let datePrograms: any[] = [];
                try {
                    datePrograms = await grabber.grab(grabberChannel, date, config) || [];
                } catch (err: any) {
                    emitLog(`Failed to grab single channel ${xmltvId} on site ${site} for date ${date.format('YYYY-MM-DD')}: ${err.message}`, "warning");
                }

                if (datePrograms.length > 0) {
                    const batchArgs: any[] = [];
                    for (const prog of datePrograms) {
                        batchArgs.push([
                            xmltvId,
                            `iptv-org:${site}`,
                            dayjs(prog.start).utc().format('YYYYMMDDHHmmss ZZ'),
                            dayjs(prog.stop).utc().format('YYYYMMDDHHmmss ZZ'),
                            prog.titles?.[0]?.value || '',
                            prog.descriptions?.[0]?.value || '',
                            prog.subTitles?.[0]?.value || '',
                            prog.episodeNumbers?.[0]?.value || '',
                            prog.categories?.map((cat: any) => cat.value).join(', ') || '',
                            prog.ratings?.[0]?.value || '',
                            prog.icons?.[0]?.src || ''
                        ]);
                    }
                    const placeholders = batchArgs.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
                    await db.execute('BEGIN TRANSACTION');
                    await db.execute({
                        sql: `INSERT INTO epg_programs (channel_id, source, start, stop, title, desc, sub_title, episode_num, category, rating, icon) VALUES ${placeholders}`,
                        args: batchArgs.flat()
                    });
                    await db.execute('COMMIT');
                    totalForChannel += datePrograms.length;
                    datePrograms = [];
                }
            }

            if (totalForChannel > 0) {
                const duration = Date.now() - startTime;
                await recordGrabLog(xmltvId, site, true, `Loaded ${totalForChannel} programs in-process`, totalForChannel, duration);
                await recordSiteAttempt(site, true);
                await recordChannelGrabResult(xmltvId, true);
                await recordChannelSiteResult(xmltvId, site, true, totalForChannel);

                return true;
            } else {
                const duration = Date.now() - startTime;
                await recordGrabLog(xmltvId, site, false, `Site returned 0 programs in-process`, 0, duration);
                await recordSiteAttempt(site, false);
                await recordChannelSiteResult(xmltvId, site, false, 0);
                lastError = `${site} returned 0 programs`;
            }
        } catch (e: any) {
            lastError = e.message;
            await recordSiteAttempt(site, false);
            await recordChannelSiteResult(xmltvId, site, false, 0);
        }
    }

    const duration = Date.now() - startTime;
    await recordGrabLog(xmltvId, 'all', false, lastError || 'All sites failed or returned 0 programs in-process', 0, duration);
    const wasDisabled = await recordChannelGrabResult(xmltvId, false);
    if (wasDisabled) {
        emitLog(`Channel ${xmltvId} auto-disabled after failures`, 'warning');
    }
    return false;
}

async function recordGrabLog(xmltvId: string, site: string, success: boolean, message: string, programCount: number, durationMs: number) {
    await db.execute({
        sql: `INSERT INTO grab_logs (xmltv_id, site, timestamp, success, message, program_count, duration_ms) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [xmltvId, site, Date.now(), success ? 1 : 0, message, programCount, durationMs]
    });
}
