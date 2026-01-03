import axios from 'axios';
import { db, DB_DIR } from '../db';
import { XMLBuilder } from 'fast-xml-parser';
import * as zlib from 'zlib';
import { promisify } from 'util';
import Fuse from 'fuse.js';
import { emitLog, emitProgress, eventBus } from '../events';
import { startJob, completeJob } from '../job';
import * as fs from 'fs';
import * as path from 'path';
import sax from 'sax';
import { updateIptvOrgData } from './iptv-org';
import { StringDecoder } from 'string_decoder';
// cliProgress removed

const gunzip = promisify(zlib.gunzip);

interface EpgFileOption {
    name: string;
    url: string;
}

export async function getEpgFiles(): Promise<EpgFileOption[]> {
    // Premade EPG files are no longer used in favor of custom grabbing.
    // This function returns an empty list or could be repurposed for local XML files.
    return [];
}

export function normalizeId(id: string): string {
    return id
        .replace(/@.*/, '') 
        .replace(/\.us[0-9]*$/i, '') 
        .replace(/\(.*\)/g, '')
        .replace(/\[.*\]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase();
}

export function cleanName(name: string): string {
    return name
        .replace(/\(.*\)/g, '')
        .replace(/\[.*\]/g, '')
        .replace(/\b\d{3,4}p\b/g, '') 
        .replace(/\b(HD|FHD|SD|4K|HEVC|UHD)\b/gi, '') 
        .replace(/\b(US|UK|CA|AU|ES|MX|FR|DE|IT|FRANCE|USA):/gi, '') 
        .replace(/[^a-zA-Z0-9\s]/g, '') 
        .replace(/\s+/g, ' ')
        .trim();
}

export function getText(val: any): string {
    if (val === undefined || val === null) return "";
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export async function processEpg(epgUrls: string[], options: { skipIptvUpdate?: boolean, skipMatching?: boolean } = {}): Promise<Record<string, number>> {
    if (typeof epgUrls === 'string') epgUrls = [epgUrls];
    
    startJob();
    let totalChannelsProcessed = 0;
    let totalProgramsProcessed = 0;
    
    if (!options.skipIptvUpdate) {
        await updateIptvOrgData();
    }
    
    const programCounts: Record<string, number> = {};
    for (let i = 0; i < epgUrls.length; i++) {
        const url = epgUrls[i];
        const isLocal = !url.startsWith('http');
        
        emitLog(`Processing source ${i+1}/${epgUrls.length}: ${url}`, "info", true);

        await db.execute({ sql: "DELETE FROM epg_programs WHERE source = ?", args: [url] });
        await db.execute({ sql: "DELETE FROM epg_channels WHERE source = ?", args: [url] });

        try {
            // ... (rest of the try block remains mostly same, but we accumulate programCounts)
            let inputStream: fs.ReadStream | any;
            // ... (skipping some lines for brevity in ReplacementChunk)
            let finalStream: any;
            let totalBytes = 0;
            let downloadedBytes = 0;

            if (isLocal) {
                const stats = fs.statSync(url);
                totalBytes = stats.size;
                inputStream = fs.createReadStream(url);
                finalStream = inputStream;
                emitLog(`Loading local EPG: ${url.split('/').pop()}`, "info", true);
                emitProgress(`Loading local file...`, 0, totalBytes, 'match');
            } else {
                emitLog(`Downloading EPG: ${url}`, "info", true);
                emitProgress(`Connecting to ${url.split('/').pop()}...`, 0, 100, 'match');
                try {
                    const response = await axios({ url, method: 'GET', responseType: 'stream' });
                    totalBytes = parseInt(response.headers['content-length'] || '0', 10);
                    inputStream = response.data;
                    
                    let lastProgressEmit = 0;
                    inputStream.on('data', (chunk: Buffer) => {
                        downloadedBytes += chunk.length;
                        const now = Date.now();
                        if (totalBytes > 0 && now - lastProgressEmit > 500) { // Throttle to 500ms
                            const pct = Math.round((downloadedBytes / totalBytes) * 100);
                            emitProgress(`Downloading: ${pct}%`, downloadedBytes, totalBytes, 'match');
                            lastProgressEmit = now;
                        }
                    });
                    
                    if (url.endsWith('.gz')) {
                        finalStream = inputStream.pipe(zlib.createGunzip());
                    } else {
                        finalStream = inputStream;
                    }
                } catch (err: any) {
                    emitLog(`Download failed for ${url}: ${err.message}`, "error");
                    throw err;
                }
            }

            const parser = sax.parser(true, { trim: true, normalize: true });

            let currentTag = "";
            let currentChannel: any = null;
            let currentProgram: any = null;
            let currentEpisodeSystem = "";
            let channelBatch: any[] = [];
            let programBatch: any[] = [];
            let totalChannels = 0;
            let totalPrograms = 0;
            let lastProgressUpdate = 0;

            const commitBatch = async (table: 'channels'|'programs', batch: any[]) => {
                if (batch.length === 0) return;
                const placeholders = batch.map(() => table === 'channels' ? "(?, ?, ?, ?)" : "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
                const sql = table === 'channels' 
                    ? `INSERT OR IGNORE INTO epg_channels (id, source, display_name, icon) VALUES ${placeholders}`
                    : `INSERT INTO epg_programs (channel_id, source, start, stop, title, desc, sub_title, episode_num, category, rating, icon) VALUES ${placeholders}`;
                await db.execute("BEGIN TRANSACTION");
                await db.execute({ sql, args: batch.flat() });
                await db.execute("COMMIT");
            };

            parser.onopentag = (node: any) => {
                currentTag = node.name;
                if (node.name === "channel") {
                    currentChannel = { id: node.attributes.id, source: url, displayName: "", icon: "" };
                } else if (node.name === "programme") {
                    currentProgram = { 
                        channel: node.attributes.channel, 
                        start: node.attributes.start, 
                        stop: node.attributes.stop, 
                        source: url, 
                        title: "", 
                        desc: "",
                        subTitle: "",
                        episodeNum: "",
                        category: "",
                        rating: "",
                        icon: ""
                    };
                } else if (node.name === "icon") {
                    if (currentChannel) currentChannel.icon = node.attributes.src;
                    else if (currentProgram) currentProgram.icon = node.attributes.src || "";
                } else if (node.name === "episode-num") {
                    // Store system type for potential formatting
                    currentEpisodeSystem = node.attributes.system || "onscreen";
                }
            };

            parser.ontext = (text: string) => {
                if (!currentTag) return;
                if (currentChannel && currentTag === "display-name") currentChannel.displayName = text;
                else if (currentProgram) {
                    if (currentTag === "title") currentProgram.title = text;
                    else if (currentTag === "desc") currentProgram.desc = text;
                    else if (currentTag === "sub-title") currentProgram.subTitle = text;
                    else if (currentTag === "episode-num") currentProgram.episodeNum = text;
                    else if (currentTag === "category") {
                        // Accumulate multiple categories
                        currentProgram.category = currentProgram.category 
                            ? currentProgram.category + ", " + text 
                            : text;
                    }
                    else if (currentTag === "value" && currentProgram.rating === "") {
                        // Rating value
                        currentProgram.rating = text;
                    }
                }
            };

            parser.onclosetag = (tagName: string) => {
                if (tagName === "channel" && currentChannel) {
                    channelBatch.push([currentChannel.id, currentChannel.source, currentChannel.displayName, currentChannel.icon]);
                    currentChannel = null;
                    totalChannels++;
                } else if (tagName === "programme" && currentProgram) {
                    const chId = currentProgram.channel;
                    programBatch.push([
                        chId, 
                        currentProgram.source, 
                        currentProgram.start, 
                        currentProgram.stop, 
                        currentProgram.title, 
                        currentProgram.desc,
                        currentProgram.subTitle,
                        currentProgram.episodeNum,
                        currentProgram.category,
                        currentProgram.rating,
                        currentProgram.icon
                    ]);
                    
                    programCounts[chId] = (programCounts[chId] || 0) + 1;
                    
                    currentProgram = null;
                    totalPrograms++;
                }
            };

            const decoder = new StringDecoder('utf8');
            // Use for-await-of for streaming backpressure
            for await (const chunk of finalStream) {
                const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
                parser.write(text);
                
                // Flush batches after each chunk to maximize memory efficiency
                if (channelBatch.length > 0) {
                    const b = [...channelBatch]; channelBatch = [];
                    await commitBatch('channels', b);
                    
                    if (totalChannels - lastProgressUpdate >= 50) {
                        emitProgress(`${url.split('/').pop()}: ${totalChannels} channels...`, totalChannels, 0, 'match');
                        lastProgressUpdate = totalChannels;
                    }
                }
                
                if (programBatch.length >= 200) {
                    const b = [...programBatch]; programBatch = [];
                    await commitBatch('programs', b);
                    
                    if (totalPrograms % 1000 === 0 || totalPrograms % 500 === 0) {
                        emitProgress(`${url.split('/').pop()}: ${totalChannels} ch, ${totalPrograms} progs...`, totalPrograms, 0, 'match');
                    }
                }
                
                // Yield to event loop to allow SSE/Network to breathe
                await new Promise(r => setImmediate(r));
            }
            
            // Final flush
            const finalText = decoder.end();
            if (finalText) parser.write(finalText);
            
            await commitBatch('channels', channelBatch);
            await commitBatch('programs', programBatch);
            parser.close();
            
            totalChannelsProcessed += totalChannels;
            totalProgramsProcessed += totalPrograms;
            emitLog(`Source ${url}: ${totalChannels} channels, ${totalPrograms} progs.`, "info", true);
        } catch (e: any) {
            emitLog(`Error source ${url}: ${e.message}`, "error");
        }
    }

    if (options.skipMatching) return programCounts;

    // Matching Logic...
    const epgChannelsResult = await db.execute("SELECT id as _id, display_name as \"display-name\" FROM epg_channels");
    const allEpgChannels = epgChannelsResult.rows;
    const dbChannelsResult = await db.execute("SELECT * FROM channels");
    const dbChannels = dbChannelsResult.rows;

    const fuse = new Fuse(allEpgChannels, { keys: ['display-name'], threshold: 0.25, includeScore: true });
    const overridesRes = await db.execute("SELECT * FROM manual_overrides");
    const overrides = new Map(overridesRes.rows.map(r => [r.channel_id, r.epg_id]));

    let matchCount = 0;
    const updates: Promise<any>[] = [];

    for (let i = 0; i < dbChannels.length; i++) {
        const row = dbChannels[i];
        let match: any = null;
        let matchType = "";

        // NEW: Check for existing match first (Confirm match)
        if (row.matched_epg_id) {
            const existing = allEpgChannels.find((c: any) => String(c._id) === String(row.matched_epg_id));
            if (existing) {
                match = existing;
                matchType = row.match_type ? String(row.match_type) : "Confirmed Match";
                if (!matchType.includes("(Confirmed)")) matchType += " (Confirmed)";
            }
        }

        if (!match && overrides.has(row.id)) {
            const oid = overrides.get(row.id);
            match = allEpgChannels.find((c: any) => c._id === oid);
            if (match) matchType = "Manual Override";
        }

        if (!match && row.match_type && String(row.match_type).includes("IPTV-ORG Map")) {
             match = allEpgChannels.find((c: any) => c._id === row.matched_epg_id);
             if (match) matchType = "IPTV-ORG Map (Verified)";
             else {
                 match = { _id: row.matched_epg_id, 'display-name': row.name };
                 matchType = row.match_type as string; 
             }
        }

        if (!match && row.tvg_id) {
            // Exact ID match
            match = allEpgChannels.find((c: any) => c._id === row.tvg_id);
            if (match) matchType = "ID (Exact)";
        }
        
        // Try partial ID match (e.g., tvg_id contains the EPG channel ID or vice versa)
        if (!match && row.tvg_id) {
            const tid = String(row.tvg_id).toLowerCase();
            match = allEpgChannels.find((c: any) => {
                const eid = String(c._id).toLowerCase();
                return tid.includes(eid) || eid.includes(tid);
            });
            if (match) matchType = "ID (Partial)";
        }

        if (!match && row.name) {
            const cn = cleanName(row.name as string).toLowerCase();
            match = allEpgChannels.find((c: any) => cleanName(getText(c['display-name'])).toLowerCase() === cn);
            if (match) matchType = "Strict Clean";
        }

        if (!match && row.name) {
            const results = fuse.search(cleanName(row.name as string));
            if (results.length > 0 && (results[0].score as number) <= 0.25) {
                match = results[0].item;
                matchType = `Fuzzy (${results[0].score?.toFixed(2)})`;
            }
        }

        if (match) {
            matchCount++;
            updates.push(db.execute({
                sql: "UPDATE channels SET matched_epg_id = ?, match_type = ? WHERE id = ?",
                args: [(match as any)._id, matchType, row.id]
            }));
        } else {
             updates.push(db.execute({
                sql: "UPDATE channels SET matched_epg_id = NULL, match_type = NULL WHERE id = ?",
                args: [row.id]
            }));
        }
    }

    await db.execute("BEGIN TRANSACTION");
    await Promise.all(updates);
    await db.execute("COMMIT");

    emitLog(`EPG processing complete. Matched ${matchCount}/${dbChannels.length} channels against EPG sources.`, "success");
    
    return programCounts;
}

/**
 * Match all channels in the database against IPTV-ORG metadata
 * Priorities: 
 * 1. Exact match on tvg-id vs xmltv-id
 * 2. Exact match on clean name vs iptv name
 * 3. Fuzzy match on name
 */
export async function matchChannelsToIptvOrg(): Promise<number> {
    emitLog("Starting full channel matching against IPTV-ORG metadata...", "info");
    
    // 1. Get all channels from our playlist
    const dbChannels = (await db.execute("SELECT * FROM channels")).rows;
    if (dbChannels.length === 0) {
        emitLog("No channels found in database to match.", "warning");
        return 0;
    }

    // 2. Get all IPTV-ORG metadata
    const iptvOrgChannels = (await db.execute(`
        SELECT xmltv_id, name, site, site_id FROM iptv_org_map 
        WHERE site IS NOT NULL AND site_id IS NOT NULL
    `)).rows;
    
    // Create maps for fast lookups
    const idMap = new Map();
    const nameMap = new Map();
    for (const row of iptvOrgChannels) {
        idMap.set(String(row.xmltv_id).toLowerCase(), row);
        const cName = cleanName(String(row.name));
        if (cName) nameMap.set(cName, row);
    }

    // Fuzzy Search Index
    const iptvFuse = new Fuse(iptvOrgChannels, { 
        keys: ['name', 'xmltv_id'], 
        threshold: 0.3, 
        includeScore: true 
    });
    
    let matchedCount = 0;
    let prevMatchCount = 0;
    const updates: Promise<any>[] = [];
    const total = dbChannels.length;
    // Removed redundant emitLog here

    const STARTING_CHANNEL_NUMBER = 700;
    let nextNumber = STARTING_CHANNEL_NUMBER;
    // Find highest current number to continue from if some are pre-set (only if >= 700)
    const currentMax = dbChannels.reduce((max: number, ch: any) => {
        const num = Number(ch.channel_number) || 0;
        return num >= STARTING_CHANNEL_NUMBER ? Math.max(max, num) : max;
    }, 0);
    if (currentMax > 0) nextNumber = currentMax + 1;

    emitProgress('Initializing matching...', 0, total, 'match');

    const getBaseMessage = (matchCount: number) => {
        return `Matching... (${matchCount}/${total} matched)`;
    }

    for (let i = 0; i < total; i++) {
        const ch = dbChannels[i];
        let matched = false;
        let matchReason = "";
        let matchedEpgId = "";

        const iterationBaseMessage = `${getBaseMessage(matchedCount)} (${ch.name}-${ch.tvg_id}-${ch.xmltv_id})`;

        // a. Exact tvg-id match
        const tvgId = String(ch.tvg_id || '').toLowerCase();
        if (tvgId && idMap.has(tvgId)) {
            const match = idMap.get(tvgId);
            matchedEpgId = match.xmltv_id;
            matchReason = "Exact ID Match";
            matched = true;
            if ((i + 1) % 10 === 0) emitProgress(`${iterationBaseMessage} - ${matchReason}`, i, total, 'match');
        }



        // b. Exact Name match
        if (!matched) {
            const cName = cleanName(String(ch.name || ''));
            if (cName && nameMap.has(cName)) {
                const match = nameMap.get(cName);
                matchedEpgId = match.xmltv_id;
                matchReason = "Exact Name Match";
                matched = true;
                if ((i + 1) % 10 === 0) emitProgress(`${iterationBaseMessage} - ${matchReason}`, i, total, 'match');
            }
        }

        // c. Fuzzy Name match
        if (!matched) {
            const cName = cleanName(String(ch.name || ''));
            if (cName) {
                const results = iptvFuse.search(cName);
                if (results.length > 0 && (results[0].score as number) <= 0.3) {
                    const match = results[0].item as any;
                    matchedEpgId = match.xmltv_id;
                    matchReason = `Fuzzy Name Match (${results[0].score?.toFixed(2)})`;
                    matched = true;
                    if ((i + 1) % 10 === 0) emitProgress(`${iterationBaseMessage} - ${matchReason}`, i, total, 'match');
                }
            }
        }

        // Handle auto-numbering
        let channelNumber = ch.channel_number;
        if (!channelNumber) {
            channelNumber = nextNumber++;
        }

        if (matched || !ch.channel_number) {
            if (matched) matchedCount++;
            updates.push(db.execute({
                sql: "UPDATE channels SET matched_epg_id = ?, match_type = ?, channel_number = ? WHERE id = ?",
                args: [matchedEpgId || ch.matched_epg_id, matched ? matchReason : ch.match_type, channelNumber, ch.id]
            }));
            // Only update bar if something changed and it's been a few channels
            if ((i + 1) % 10 === 0 || i === total - 1) {
                emitProgress(`${iterationBaseMessage} - channel number assigned`, i, total, 'match');
            }
        }

        // Progress logging - more frequent updates
        if ((i + 1) % 5 === 0 || i === total - 1) {
            const msg = `Matching... (${matchedCount}/${total} matched) - ${String(ch.name || '').substring(0, 30)}`;
            emitProgress(msg, i + 1, total, 'match');
            
            // YIELD to prevent HTTP starvation
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    if (updates.length > 0) {
        await db.execute("BEGIN TRANSACTION");
        await Promise.all(updates);
        await db.execute("COMMIT");
}
    
    emitLog(`Matching complete. ${matchedCount} channels matched to IPTV-ORG sites.`, "success");
    emitProgress(`Complete: ${matchedCount}/${total} channels matched ✓`, total, total, 'match');
    return matchedCount;
}


/**
 * Cleanup EPG data - remove expired programs and orphaned entries
 */
export async function cleanupEpgData(): Promise<{expiredRemoved: number, orphanedRemoved: number}> {
    emitLog("Cleaning up EPG data...", "info");
    
    // Get current time in XMLTV format (YYYYMMDDHHmmss +0000)
    const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    
    // 1. Remove expired programs (stop time is in the past)
    const expiredResult = await db.execute({
        sql: `DELETE FROM epg_programs WHERE stop < ?`,
        args: [now]
    });
    const expiredRemoved = expiredResult.rowsAffected || 0;
    
    // 2. Get the list of valid EPG IDs (enabled + matched channels)
    const validIdsResult = await db.execute(`
        SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id) as epg_id
        FROM channels c
        LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
        WHERE c.enabled = 1
        AND (mo.epg_id IS NOT NULL OR c.matched_epg_id IS NOT NULL)
    `);
    const validIds = validIdsResult.rows.map(r => String(r.epg_id));
    
    // 3. Remove orphaned programs (channels that don't exist or are disabled/unmatched)
    let orphanedRemoved = 0;
    if (validIds.length > 0) {
        const placeholders = validIds.map(() => '?').join(',');
        const orphanedResult = await db.execute({
            sql: `DELETE FROM epg_programs WHERE channel_id NOT IN (${placeholders})`,
            args: validIds
        });
        orphanedRemoved = orphanedResult.rowsAffected || 0;
    } else {
        // No valid channels, remove all program data
        const orphanedResult = await db.execute(`DELETE FROM epg_programs`);
        orphanedRemoved = orphanedResult.rowsAffected || 0;
    }
    
    // 4. Remove orphaned EPG channels
    if (validIds.length > 0) {
        const placeholders = validIds.map(() => '?').join(',');
        await db.execute({
            sql: `DELETE FROM epg_channels WHERE id NOT IN (${placeholders})`,
            args: validIds
        });
    } else {
        await db.execute(`DELETE FROM epg_channels`);
    }
    
    if (expiredRemoved > 0 || orphanedRemoved > 0) {
        emitLog(`Cleanup complete: ${expiredRemoved} expired programs, ${orphanedRemoved} orphaned entries removed.`, "success");
    } else {
        emitLog("Cleanup complete: No stale data found.", "info");
    }
    
    return { expiredRemoved, orphanedRemoved };
}


/**
 * Generate playlist.m3u and epg.xml from current database state
 * Called after custom grabbing is complete
 */
export async function generatePlaylistAndEpg(): Promise<{playlistCount: number, epgChannels: number, epgPrograms: number}> {
    emitLog("Generating final playlist and EPG files...", "info");
    
    // Get ALL enabled channels (for EPG XML)
    const enabledChannels = (await db.execute(`
        SELECT DISTINCT 
            c.*, 
            COALESCE(mo.epg_id, c.matched_epg_id) as effective_epg_id
        FROM channels c
        LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
        WHERE c.enabled = 1
    `)).rows;
    
    // Only matched channels go into M3U (for player compatibility)
    const matchedChannels = enabledChannels.filter(c => c.effective_epg_id);
    
    emitLog(`Generating files: ${enabledChannels.length} enabled, ${matchedChannels.length} matched to EPG`, "info");
    
    // Generate M3U (only matched channels)
    let m3u = "#EXTM3U\n";
    for (const r of matchedChannels) {
        const logo = r.tvg_logo ? getText(String(r.tvg_logo)) : '';
        const group = r.group_title ? getText(String(r.group_title)) : '';
        const chNum = r.channel_number ? ` tvg-chno="${r.channel_number}"` : '';
        const epgId = String(r.effective_epg_id);
        m3u += `#EXTINF:-1 tvg-id="${epgId}"${chNum} tvg-logo="${logo}" group-title="${group}",${getText(String(r.name))}\n${r.url}\n`;
    }
    fs.writeFileSync(path.join(DB_DIR, 'playlist.m3u'), m3u);
    const m3uSize = (m3u.length / 1024).toFixed(1);
    emitLog(`Generated playlist.m3u: ${matchedChannels.length} channels, ${m3uSize} KB`, "success");
    
    // Generate EPG XML - include ALL enabled channels with available guide data
    // Use effective_epg_id if available, otherwise fall back to tvg_id or channel id
    const epgChannelList = enabledChannels.map(c => ({
        id: c.effective_epg_id || c.tvg_id || c.id,
        name: c.name,
        logo: c.tvg_logo
    }));
    
    // Get unique EPG IDs for querying program data
    const allEpgIds = [...new Set(epgChannelList.map(c => String(c.id)))];
    let epgProgramCount = 0;
    
    if (allEpgIds.length > 0) {
        emitLog(`Generating epg.xml for ${allEpgIds.length} channels (all enabled)...`, "info");
        const idList = allEpgIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(",");
        const fileStream = fs.createWriteStream(path.join(DB_DIR, 'epg.xml'));
        fileStream.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');
        
        // First, write channel info from epg_channels table (if available)
        const epgChannelsData = await db.execute(`SELECT * FROM epg_channels WHERE id IN (${idList})`);
        const epgChannelMap = new Map(epgChannelsData.rows.map(c => [String(c.id), c]));
        
        // Write all channel entries - use epg_channels data if available, otherwise use playlist data
        for (const ch of epgChannelList) {
            const epgData = epgChannelMap.get(String(ch.id));
            const displayName = epgData?.display_name || ch.name;
            const icon = epgData?.icon || ch.logo;
            let channelXml = `  <channel id="${getText(ch.id)}"><display-name>${getText(displayName)}</display-name>`;
            if (icon) channelXml += `<icon src="${getText(icon)}" />`;
            channelXml += `</channel>\n`;
            fileStream.write(channelXml);
        }
        
        // Get total program count for progress
        const countRes = await db.execute(`SELECT COUNT(*) as c FROM epg_programs WHERE channel_id IN (${idList})`);
        epgProgramCount = Number(countRes.rows[0].c);
        emitLog(`Writing ${epgProgramCount.toLocaleString()} programs to epg.xml...`, "info");
        
        // Write programs in batches - join with TVMaze cache for enriched metadata
        for (let offset = 0; offset < epgProgramCount; offset += 5000) {
            const progs = await db.execute(`
                SELECT p.*, 
                       tc.genres as tvmaze_genres, 
                       tc.rating as tvmaze_rating
                FROM epg_programs p
                LEFT JOIN tvmaze_cache tc ON p.tmdb_id = tc.tvmaze_id
                WHERE p.channel_id IN (${idList}) 
                LIMIT 5000 OFFSET ${offset}
            `);
            for (const p of progs.rows) {
                let xml = `  <programme start="${p.start}" stop="${p.stop}" channel="${getText(p.channel_id)}">`;
                xml += `<title>${getText(p.title)}</title>`;
                if (p.sub_title) xml += `<sub-title>${getText(p.sub_title)}</sub-title>`;
                if (p.desc) xml += `<desc>${getText(p.desc)}</desc>`;
                if (p.episode_num) xml += `<episode-num system="onscreen">${getText(p.episode_num)}</episode-num>`;
                
                // Use TVMaze genres if available, fallback to original category
                const categories = p.tvmaze_genres || p.category;
                if (categories) {
                    const cats = String(categories).split(', ');
                    for (const cat of cats) {
                        xml += `<category>${getText(cat)}</category>`;
                    }
                }
                
                // Use TVMaze rating if available, fallback to original
                const rating = p.tvmaze_rating || p.rating;
                if (rating) xml += `<rating><value>${getText(rating)}</value></rating>`;
                if (p.icon) xml += `<icon src="${getText(p.icon)}" />`;
                xml += `</programme>\n`;
                fileStream.write(xml);
            }
        }
        fileStream.write('</tv>');
        await new Promise<void>((resolve, reject) => {
            fileStream.end(() => resolve());
            fileStream.on('error', reject);
        });
    }
    
    const epgPath = path.join(DB_DIR, 'epg.xml');
    const epgStats = fs.existsSync(epgPath) ? fs.statSync(epgPath) : null;
    const epgSize = epgStats ? (epgStats.size / 1024 / 1024).toFixed(1) : '0';
    emitLog(`Generated epg.xml: ${allEpgIds.length} channels, ${epgProgramCount.toLocaleString()} programs, ${epgSize} MB`, "success");
    
    return {
        playlistCount: matchedChannels.length,
        epgChannels: allEpgIds.length,
        epgPrograms: epgProgramCount
    };
}

