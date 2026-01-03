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

    // Get ALL site options for each channel (we'll try them in order)
    const placeholders = xmltvIds.map(() => "?").join(",");
    const res = await db.execute({
        sql: `
            SELECT m.xmltv_id, m.site, m.site_id, m.lang 
            FROM iptv_org_map m
            WHERE m.xmltv_id IN (${placeholders}) AND m.site IS NOT NULL
            ORDER BY m.xmltv_id, m.site
        `,
        args: xmltvIds
    });

    if (res.rows.length === 0) {
        emitLog("No site metadata found for requested channels.", "warning");
        return;
    }

    // Group sites by channel - each channel can have multiple fallback sites
    const channelSites: Map<string, ChannelSiteInfo> = new Map();
    for (const row of res.rows) {
        const xmltv_id = String(row.xmltv_id);
        if (!channelSites.has(xmltv_id)) {
            channelSites.set(xmltv_id, { xmltv_id, sites: [] });
        }
        channelSites.get(xmltv_id)!.sites.push({
            site: String(row.site),
            site_id: String(row.site_id),
            lang: String(row.lang || 'en')
        });
    }

    const channels = Array.from(channelSites.values());
    emitLog(`Processing ${channels.length} unique channels...`, "info");
    emitProgress(`Grabbing EPG for ${channels.length} channels...`, 0, channels.length, 'grab');

    let completed = 0;
    let successful = 0;
    let failed = 0;
    const CONCURRENCY_LIMIT = 10;
    const activePromises = new Set<Promise<void>>();
    let channelIndex = 0;

    const processChannel = async (channel: ChannelSiteInfo) => {
        const startTime = Date.now();
        let lastError = '';
        
        // Try each site in order until one succeeds
        for (const siteInfo of channel.sites) {
            const { site, site_id, lang } = siteInfo;
            
            // Check if we should skip this site due to failures
            if (await shouldSkipSite(site)) {
                continue; // Try next site
            }
            
            const tempId = Math.random().toString(36).substring(7);
            const tempXmlPath = path.join('/tmp', `grab_${tempId}.channels.xml`);
            const tempOutputPath = path.join('/tmp', `grab_${tempId}.xml`);
            
            try {
                // Create channel XML for this specific site
                const xml = `<?xml version="1.0" encoding="UTF-8"?>
<channels>
  <channel site="${site}" site_id="${site_id}" xmltv_id="${channel.xmltv_id}" lang="${lang}">${channel.xmltv_id}</channel>
</channels>`;
                fs.writeFileSync(tempXmlPath, xml);
                
                await runGrabCommand(tempXmlPath, tempOutputPath, epgDays);
                
                if (fs.existsSync(tempOutputPath)) {
                    const duration = Date.now() - startTime;
                    
                    // Delete old iptv-org data for this channel BEFORE inserting new
                    await db.execute({
                        sql: `DELETE FROM epg_programs WHERE channel_id = ? AND source LIKE '%iptv-org%'`,
                        args: [channel.xmltv_id]
                    });
                    
                    // Process the new EPG data
                    const counts = await processEpg([tempOutputPath], { skipIptvUpdate: true, skipMatching: true });
                    const count = counts[channel.xmltv_id] || 0;
                    
                    // Cleanup temp files
                    if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                    if (fs.existsSync(tempXmlPath)) fs.unlinkSync(tempXmlPath);
                    
                    // If we got 0 programs, try the next site instead!
                    if (count === 0) {
                        await recordGrabLog(channel.xmltv_id, site, false, `Site returned 0 programs, trying next`, 0, duration);
                        await recordSiteAttempt(site, false);
                        lastError = `${site} returned 0 programs`;
                        continue; // Try next site
                    }
                    
                    await recordGrabLog(channel.xmltv_id, site, true, `Loaded ${count} programs`, count, duration);
                    await recordSiteAttempt(site, true);
                    await recordChannelGrabResult(channel.xmltv_id, true); // Track channel success
                    
                    successful++;
                    return; // Success! Don't try other sites
                }
            } catch (e: any) {
                lastError = e.message;
                await recordSiteAttempt(site, false);
                
                // Cleanup
                if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                if (fs.existsSync(tempXmlPath)) fs.unlinkSync(tempXmlPath);
                
                // Continue to next site
            }
        }
        
        // All sites failed for this channel
        const duration = Date.now() - startTime;
        await recordGrabLog(channel.xmltv_id, 'all', false, lastError || 'All sites failed or returned 0 programs', 0, duration);
        const wasDisabled = await recordChannelGrabResult(channel.xmltv_id, false); // Track channel failure
        if (wasDisabled) {
            emitLog(`Channel ${channel.xmltv_id} has been auto-disabled due to repeated failures`, 'warning');
        }
        failed++;
    };

    // Process channels with concurrency limit
    while (channelIndex < channels.length || activePromises.size > 0) {
        // Start new jobs up to concurrency limit
        while (activePromises.size < CONCURRENCY_LIMIT && channelIndex < channels.length) {
            const channel = channels[channelIndex++];
            
            const p = processChannel(channel).finally(() => {
                activePromises.delete(p);
                completed++;
                emitProgress(
                    `Grabbing: ${completed}/${channels.length} (${successful} ok, ${failed} failed)`,
                    completed,
                    channels.length,
                    'grab'
                );
            });
            
            activePromises.add(p);
        }
        
        if (activePromises.size > 0) {
            await Promise.race(activePromises);
        }
    }

    emitLog(`EPG grab complete: ${successful} succeeded, ${failed} failed out of ${channels.length} channels`, "success");
    emitProgress(`Complete: ${successful}/${channels.length} channels grabbed ✓`, channels.length, channels.length, 'grab');
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
        const proc = spawn('npm', [
            'run',
            'grab',
            '--',
            '--channels', channelsPath,
            '--output', outputPath,
            '--days', days
        ], {
            cwd: REPO_DIR,
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' },
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
