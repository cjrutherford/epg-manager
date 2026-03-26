import { db, DB_DIR } from '../db';
import { emitLog, emitProgress } from '../events';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { processEpg } from './epg';

const REPO_DIR = path.join(DB_DIR, 'iptv-org-epg');
const MAX_FAILURES_BEFORE_SKIP = 3; // Skip site after 3 consecutive failures
const RETRY_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours
const MAX_CHANNEL_FAILURES_BEFORE_DISABLE = 5; // Auto-disable channel after 5 consecutive failures

interface ChannelSiteInfo {
    xmltv_id: string;
    sites: Array<{ site: string; site_id: string; lang: string }>;
}

async function shouldSkipSite(site: string): Promise<boolean> {
    const result = await db.execute({
        sql: "SELECT last_attempt, last_success, failure_count FROM site_status WHERE site = ?",
        args: [site]
    });

    if (result.rows.length === 0) return false;

    const row = result.rows[0];
    const failureCount = Number(row.failure_count) || 0;
    const lastAttempt = Number(row.last_attempt) || 0;
    const now = Date.now();

    if (failureCount >= MAX_FAILURES_BEFORE_SKIP) {
        const timeSinceLastAttempt = now - lastAttempt;
        if (timeSinceLastAttempt < RETRY_INTERVAL_MS) {
            return true;
        }
    }

    return false;
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

export async function grabMissingChannels(xmltvIds: string[]) {
    if (xmltvIds.length === 0) return;

    // Get epg_days from settings
    const daysResult = await db.execute("SELECT value FROM settings WHERE key = 'epg_days'");
    const epgDays = daysResult.rows.length > 0 ? String(daysResult.rows[0].value) : '2';

    emitLog(`Starting EPG grab for ${xmltvIds.length} channels (${epgDays} days)...`, "info");
    emitProgress(`Grabbing EPG for ${xmltvIds.length} channels...`, 0, xmltvIds.length, 'grab');

    let completed = 0;
    let successful = 0;
    let failed = 0;
    const CONCURRENCY_LIMIT = 10;
    const activePromises = new Set<Promise<void>>();
    let index = 0;

    while (index < xmltvIds.length || activePromises.size > 0) {
        while (activePromises.size < CONCURRENCY_LIMIT && index < xmltvIds.length) {
            const id = xmltvIds[index++];
            const p = grabChannel(id, epgDays).then(success => {
                if (success) successful++;
                else failed++;
            }).finally(() => {
                activePromises.delete(p);
                completed++;
                emitProgress(`Grabbing: ${completed}/${xmltvIds.length} (${successful} ok, ${failed} failed)`, completed, xmltvIds.length, 'grab');
            });
            activePromises.add(p);
        }
        if (activePromises.size > 0) {
            await Promise.race(activePromises);
        }
    }

    emitLog(`EPG grab complete: ${successful} ok, ${failed} failed.`, "success");
}

/**
 * Grab EPG data for a single channel. Used by the streaming pipeline queue.
 * Does not emit overarching progress events.
 * Returns true if successful, false if all sites failed.
 */
export async function grabChannel(xmltvId: string, epgDays: string): Promise<boolean> {
    const res = await db.execute({
        sql: `
            SELECT m.xmltv_id, m.site, m.site_id, m.lang 
            FROM iptv_org_map m
            WHERE m.xmltv_id = ? AND m.site IS NOT NULL
            ORDER BY m.site
        `,
        args: [xmltvId]
    });

    if (res.rows.length === 0) {
        return false;
    }

    const sites: { site: string; site_id: string; lang: string }[] = [];
    for (const row of res.rows) {
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

        if (await shouldSkipSite(site)) {
            continue;
        }

        const tempId = Math.random().toString(36).substring(7);
        const tempXmlPath = path.join('/tmp', `grab_${tempId}_${xmltvId.replace(/[^a-z0-9]/gi, '_')}.channels.xml`);
        const tempOutputPath = path.join('/tmp', `grab_${tempId}_${xmltvId.replace(/[^a-z0-9]/gi, '_')}.xml`);

        try {
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<channels>
  <channel site="${site}" site_id="${site_id}" xmltv_id="${xmltvId}" lang="${lang}">${xmltvId}</channel>
</channels>`;
            fs.writeFileSync(tempXmlPath, xml);

            await runGrabCommand(tempXmlPath, tempOutputPath, epgDays);

            if (fs.existsSync(tempOutputPath)) {
                const duration = Date.now() - startTime;

                await db.execute({
                    sql: `DELETE FROM epg_programs WHERE channel_id = ? AND source LIKE '%iptv-org%'`,
                    args: [xmltvId]
                });

                const counts = await processEpg([tempOutputPath], { skipIptvUpdate: true, skipMatching: true });
                const count = counts[xmltvId] || 0;

                // Debug: verify programs were saved
                const verifyProg = await db.execute({
                    sql: `SELECT COUNT(*) as c FROM epg_programs WHERE channel_id = ?`,
                    args: [xmltvId]
                });
                emitLog(`[DEBUG] Grab ${xmltvId}: processEpg reported ${count} programs, DB has ${verifyProg.rows[0].c}`, "info");

                if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                if (fs.existsSync(tempXmlPath)) fs.unlinkSync(tempXmlPath);

                if (count === 0) {
                    await recordGrabLog(xmltvId, site, false, `Site returned 0 programs, trying next`, 0, duration);
                    await recordSiteAttempt(site, false);
                    lastError = `${site} returned 0 programs`;
                    continue;
                }

                await recordGrabLog(xmltvId, site, true, `Loaded ${count} programs`, count, duration);
                await recordSiteAttempt(site, true);
                await recordChannelGrabResult(xmltvId, true);

                return true;
            }
        } catch (e: any) {
            lastError = e.message;
            await recordSiteAttempt(site, false);

            if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
            if (fs.existsSync(tempXmlPath)) fs.unlinkSync(tempXmlPath);
        }
    }

    const duration = Date.now() - startTime;
    await recordGrabLog(xmltvId, 'all', false, lastError || 'All sites failed or returned 0 programs', 0, duration);
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

async function runGrabCommand(channelsPath: string, outputPath: string, days: string = '2'): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn('npx', [
            'tsx',
            'scripts/commands/epg/grab.ts',
            '--channels', channelsPath,
            '--output', outputPath,
            '--days', days
        ], {
            cwd: REPO_DIR,
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                const combined = (stdout + "\n" + stderr).trim();
                const lines = combined.split('\n');
                const lastLines = lines.slice(-10).join('\n');
                reject(new Error(`Exit ${code}: ${lastLines || 'Unknown error'}`));
            }
        });
        proc.on('error', (err) => reject(new Error(`Spawn error: ${err.message}`)));
    });
}
