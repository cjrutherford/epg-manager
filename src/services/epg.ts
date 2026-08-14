import axios from 'axios';
import { db, DB_DIR } from '../db';
import * as zlib from 'zlib';
import { promisify } from 'util';
import Fuse from 'fuse.js';
import { emitLog, emitProgress, emitProgressComplete, eventBus } from '../events';
import { startJob, completeJob } from '../job';
import * as fs from 'fs';
import { createAtomicWriteStream, writeFileAtomic } from './atomic-write';
import * as path from 'path';
import sax from 'sax';
import { StringDecoder } from 'string_decoder';
import { updateIptvOrgData } from './iptv-org';
import { dedupeChannelsForDisplay } from './channel-dedup';
// cliProgress removed

const gunzip = promisify(zlib.gunzip);

// ── IPTV-ORG Matching Cache ──────────────────────────────────
// Loaded once per sync cycle and reused across matching + pipeline.
// Invalidated when updateIptvOrgData() replaces the underlying data.
interface IptvOrgCache {
    idMap: Map<string, any>;
    normalizedIdMap: Map<string, any>;
    nameMap: Map<string, any>;
    nameWordMap: Map<string, any>;
    iptvFuse: Fuse<any>;
    version: number;
}
let iptvOrgCache: IptvOrgCache | null = null;
let iptvOrgCacheVersion = 0;

/** Invalidate the cache after updateIptvOrgData() replaces the underlying table. */
export function invalidateIptvOrgCache() {
    iptvOrgCache = null;
    iptvOrgCacheVersion++;
}

export function clearIptvOrgCache() {
    iptvOrgCache = null;
}

async function ensureIptvOrgCache(): Promise<IptvOrgCache> {
    if (iptvOrgCache && iptvOrgCache.version === iptvOrgCacheVersion) {
        return iptvOrgCache;
    }
    emitLog('Loading IPTV-ORG matching data into cache...', 'info');

    const iptvOrgChannels = (await db.execute(`
        SELECT esc.xmltv_id, esc.name, esc.site, esc.site_id, esc.lang, esc.source_key
        FROM epg_source_channels esc
        JOIN sources es ON es.key = esc.source_key
        WHERE es.enabled = 1
        AND es.grab_capable = 1
        AND esc.site IS NOT NULL
        AND esc.site_id IS NOT NULL
    `)).rows;
    const guideChannels = (await db.execute(`
        SELECT
            ec.id as xmltv_id,
            ec.display_name as name,
            NULL as site,
            NULL as site_id,
            NULL as lang,
            ec.source as source_key,
            'guide' as source_type
        FROM epg_channels ec
        JOIN sources es ON es.key = ec.source
        WHERE es.enabled = 1
        AND ec.id IS NOT NULL
        AND ec.display_name IS NOT NULL
    `)).rows;
    const matchChannels = [...iptvOrgChannels, ...guideChannels];

    const idMap = new Map();
    const normalizedIdMap = new Map();
    const nameMap = new Map();
    const nameWordMap = new Map();

    for (const row of matchChannels) {
        const xmltvId = String(row.xmltv_id);
        idMap.set(xmltvId.toLowerCase(), row);

        const baseId = normalizeId(xmltvId);
        if (baseId && !normalizedIdMap.has(baseId)) normalizedIdMap.set(baseId, row);

        const cName = cleanName(String(row.name));
        if (cName) {
            const lc = cName.toLowerCase();
            if (!nameMap.has(lc)) nameMap.set(lc, row);
            const wordKey = lc.split(/\s+/).sort().join(' ');
            if (!nameWordMap.has(wordKey)) nameWordMap.set(wordKey, row);
        }
    }

    const iptvFuse = new Fuse(matchChannels, {
        keys: ['name', 'xmltv_id'],
        threshold: 0.35,
        includeScore: true
    });

    iptvOrgCache = { idMap, normalizedIdMap, nameMap, nameWordMap, iptvFuse, version: iptvOrgCacheVersion };
    emitLog(`EPG matching cache loaded: ${matchChannels.length} entries (${iptvOrgChannels.length} IPTV-org, ${guideChannels.length} guide), ${idMap.size} IDs, ${nameMap.size} names.`, 'info');
    return iptvOrgCache;
}

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
        // Strip bracketed and parenthesized tags
        .replace(/\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        // Strip regional prefixes at start when followed by colon/separator (e.g. US:, UK:, CA:, | US |)
        .replace(/^(?:US|UK|CA|AU|ES|MX|FR|DE|IT|FRANCE|USA)\s*[:|│-]\s*/i, '')
        .replace(/^[|│]\s*(?:US|UK|CA|AU|ES|MX|FR|DE|IT)\s*[|│]\s*/i, '')
        // Replace separators with spaces FIRST to avoid merging words
        .replace(/[-_.:│|]/g, ' ')
        // Strip stream quality, codec, and feed tags as standalone words
        .replace(/\b\d{3,4}p\b/gi, '')
        .replace(/\b(HD|FHD|SD|4K|HEVC|H264|H265|UHD|RAW|VIP|AUTO|FPS|1080|720)\b/gi, '')
        .replace(/\b(EAST|WEST|FEED)\b/gi, '')
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

export async function processEpg(epgUrls: string[], options: { skipIptvUpdate?: boolean, skipMatching?: boolean, skipJob?: boolean } = {}): Promise<Record<string, number>> {
    if (typeof epgUrls === 'string') epgUrls = [epgUrls];

    if (!options.skipJob) startJob();
    let totalChannelsProcessed = 0;
    let totalProgramsProcessed = 0;

    if (!options.skipIptvUpdate) {
        await updateIptvOrgData();
    }

    const programCounts: Record<string, number> = {};
    for (let i = 0; i < epgUrls.length; i++) {
        const url = epgUrls[i];
        const isLocal = !url.startsWith('http');

        emitLog(`Processing source ${i + 1}/${epgUrls.length}: ${url}`, "info", true);

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
            } else {
                emitLog(`Downloading EPG: ${url}`, "info", true);
                try {
                    const response = await axios({ url, method: 'GET', responseType: 'stream' });
                    totalBytes = parseInt(String(response.headers['content-length'] || '0'), 10);
                    inputStream = response.data;

                    let lastProgressEmit = 0;
                    inputStream.on('data', (chunk: Buffer) => {
                        downloadedBytes += chunk.length;
                        const now = Date.now();
                        if (totalBytes > 0 && now - lastProgressEmit > 500) {
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

            const commitBatch = async (table: 'channels' | 'programs', batch: any[]) => {
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

                    lastProgressUpdate = totalChannels;
                }

                if (programBatch.length >= 200) {
                    const b = [...programBatch]; programBatch = [];
                    await commitBatch('programs', b);


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
    // Matching Logic...
    const epgChannelsResult = await db.execute("SELECT id as _id, display_name as \"display-name\" FROM epg_channels");
    const allEpgChannels = epgChannelsResult.rows;
    const dbChannelsResult = await db.execute("SELECT * FROM channels");
    const dbChannels = dbChannelsResult.rows;

    const overridesRes = await db.execute("SELECT * FROM manual_overrides");
    const overrides = new Map(overridesRes.rows.map(r => [r.channel_id, r.epg_id]));

    // --- Optimization: Pre-compute Maps for O(1) lookups ---
    const epgIdMap = new Map<string, any>();
    const epgNameMap = new Map<string, any>();

    // Fuse options: tuned for better accuracy
    const fuse = new Fuse(allEpgChannels, {
        keys: ['display-name'],
        threshold: 0.3, // Slightly looser than 0.25 to allow for minor variations
        includeScore: true
    });

    for (const c of allEpgChannels) {
        epgIdMap.set(String(c._id).toLowerCase(), c);

        const cleanDisplayName = cleanName(getText(c['display-name'])).toLowerCase();
        if (cleanDisplayName) {
            // Store by clean name for strict matching
            if (!epgNameMap.has(cleanDisplayName)) {
                epgNameMap.set(cleanDisplayName, c);
            }
        }
    }

    let matchCount = 0;
    const updates: Promise<any>[] = [];

    for (let i = 0; i < dbChannels.length; i++) {
        const row = dbChannels[i];
        let match: any = null;
        let matchType = "";

        // 1. Confirm Existing Match
        if (row.matched_epg_id) {
            match = epgIdMap.get(String(row.matched_epg_id).toLowerCase());
            if (match) {
                matchType = row.match_type ? String(row.match_type) : "Confirmed Match";
                if (!matchType.includes("(Confirmed)")) matchType += " (Confirmed)";
            }
        }

        // 2. Manual Override (Highest priority for new matches)
        if (!match && overrides.has(row.id)) {
            const oid = String(overrides.get(row.id)).toLowerCase();
            match = epgIdMap.get(oid);
            if (match) matchType = "Manual Override";
        }

        // 3. IPTV-ORG Map (Verified)
        if (!match && row.match_type && String(row.match_type).includes("IPTV-ORG Map")) {
            // In this specific case, the matched_epg_id might NOT be in our epg_channels table 
            // if we haven't grabbed that channel yet. 
            // But if it IS there, we confirm it.
            const mappedId = String(row.matched_epg_id).toLowerCase();
            match = epgIdMap.get(mappedId);
            if (match) {
                matchType = "IPTV-ORG Map (Verified)";
            } else {
                // Keep the mapping even if we don't have EPG data for it yet
                // But we can't "match" it against an epg_channel record that doesn't exist
                // logic remains: epg_programs will be empty, but channel has a reference ID.
                match = { _id: row.matched_epg_id, 'display-name': row.name };
                matchType = row.match_type as string;
            }
        }

        // 4. Exact ID Match (O(1))
        if (!match && row.tvg_id) {
            match = epgIdMap.get(String(row.tvg_id).toLowerCase());
            if (match) matchType = "ID (Exact)";
        }

        // 5. Partial ID Match removed — O(N²) loop with unreliable results.
        // IPTV-ORG fuzzy matching (in matchChannelsToIptvOrg) covers this better.

        const cleanDbName = row.name ? cleanName(row.name as string).toLowerCase() : "";

        // 6. Strict Clean Name Match (O(1))
        if (!match && cleanDbName) {
            match = epgNameMap.get(cleanDbName);
            if (match) matchType = "Strict Clean";
        }

        // 7. Fuzzy Name Match (Fuse.js)
        if (!match && cleanDbName) {
            // Search using the CLEAN name for better accuracy
            const results = fuse.search(cleanName(row.name as string));
            if (results.length > 0 && (results[0].score as number) <= 0.3) {
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

export function calculateMatchScore(
    ch: any,
    candidate: any,
    type: string,
    fuseScore = 1.0
): { score: number; reason: string } {
    let score = 0;
    let reason = "";

    // Base score based on how the candidate was found
    if (type === 'exact_id') {
        score += 0.90;
        reason = "Exact ID Match";
    } else if (type === 'normalized_id') {
        score += 0.85;
        reason = "Normalized ID Match";
    } else if (type === 'fast_provider') {
        score += 0.85;
        reason = "FAST Provider Match";
    } else if (type === 'exact_name') {
        score += 0.80;
        reason = "Exact Name Match";
    } else if (type === 'word_order') {
        score += 0.75;
        reason = "Word-Order Name Match";
    } else if (type === 'fuzzy') {
        const similarity = 1 - fuseScore;
        score += 0.75 * similarity;
        reason = `Fuzzy Name Match (${fuseScore.toFixed(2)})`;
    }

    // Additional signals:
    
    // Country / Language Matching
    const channelNameUpper = String(ch.name || '').toUpperCase();
    const groupNameUpper = String(ch.group_title || '').toUpperCase();
    
    const countries = ['US', 'USA', 'UK', 'GB', 'CA', 'CANADA', 'FR', 'FRANCE', 'DE', 'GERMANY', 'ES', 'SPAIN', 'MX', 'MEXICO', 'IT', 'ITALY'];
    let streamCountry = '';
    
    for (const country of countries) {
        const regex = new RegExp(`\\b${country}\\b`, 'i');
        if (regex.test(channelNameUpper) || regex.test(groupNameUpper)) {
            streamCountry = country;
            break;
        }
    }
    
    const xmltvIdUpper = String(candidate.xmltv_id || '').toUpperCase();
    const candidateLangUpper = String(candidate.lang || '').toUpperCase();
    
    if (streamCountry) {
        let epgCountry = '';
        for (const country of countries) {
            if (xmltvIdUpper.endsWith('.' + country) || xmltvIdUpper.includes('_' + country)) {
                epgCountry = country;
                break;
            }
        }
        
        if (epgCountry) {
            if (epgCountry === streamCountry || 
                (streamCountry === 'US' && epgCountry === 'USA') ||
                (streamCountry === 'USA' && epgCountry === 'US') ||
                (streamCountry === 'UK' && epgCountry === 'GB') ||
                (streamCountry === 'GB' && epgCountry === 'UK')) {
                score += 0.25;
                reason += " + Country Match";
            } else {
                score -= 0.40;
                reason += " - Country Mismatch";
            }
        } else {
            const isLangMatch = (streamCountry === 'US' || streamCountry === 'USA' || streamCountry === 'UK' || streamCountry === 'GB' || streamCountry === 'CA') && candidateLangUpper === 'EN' ||
                                (streamCountry === 'FR' || streamCountry === 'FRANCE') && candidateLangUpper === 'FR' ||
                                (streamCountry === 'DE' || streamCountry === 'GERMANY') && candidateLangUpper === 'DE' ||
                                (streamCountry === 'ES' || streamCountry === 'SPAIN' || streamCountry === 'MX' || streamCountry === 'MEXICO') && candidateLangUpper === 'ES';
            if (isLangMatch) {
                score += 0.15;
                reason += " + Lang Match";
            }
        }
    }

    return { score, reason };
}

/**
 * Match all channels in the database against IPTV-ORG metadata using a weighted scoring model.
 */
export async function matchChannelsToIptvOrg(
    onMatch?: (newlyMatchedIds: string[]) => void
): Promise<number> {
    emitLog("Starting full channel matching against IPTV-ORG metadata (Weighted Scoring Model)...", "info");
    const GRAB_BATCH_SIZE = 25; // Fire onMatch callback every N new matches
    const UPDATE_BATCH_SIZE = 100; // Batch DB writes to reduce transaction overhead

    // 1. Get all channels from our playlist
    const dbChannels = (await db.execute("SELECT * FROM channels")).rows;
    if (dbChannels.length === 0) {
        emitLog("No channels found in database to match.", "warning");
        return 0;
    }
    const matchingChannels = dedupeChannelsForDisplay(dbChannels as any[]);
    const duplicateCount = dbChannels.length - matchingChannels.length;
    if (duplicateCount > 0) {
        emitLog(`Skipping ${duplicateCount} duplicate channel entries during matching.`, "info");
    }

    // 2. Get IPTV-ORG metadata from cache
    const cache = await ensureIptvOrgCache();
    const { idMap, normalizedIdMap, nameMap, nameWordMap, iptvFuse } = cache;

    let matchedCount = 0;
    const pendingGrabIds: string[] = [];
    const total = matchingChannels.length;

    // Fetch numbering settings
    const settingsRows = (await db.execute("SELECT key, value FROM settings WHERE key IN ('channel_numbering_mode', 'custom_channel_ranges')")).rows;
    let numberingMode = 'auto-group';
    let customRanges: Record<string, number> = {};
    for (const row of settingsRows) {
        if (row.key === 'channel_numbering_mode') numberingMode = String(row.value);
        if (row.key === 'custom_channel_ranges') {
            try { customRanges = JSON.parse(String(row.value)); } catch(e) {}
        }
    }

    const STARTING_CHANNEL_NUMBER = 700;
    let nextNumber = STARTING_CHANNEL_NUMBER;
    const categoryNextNumber = new Map<string, number>();

    if (numberingMode === 'auto-group') {
        const categories = [...new Set(dbChannels.map(c => String(c.group_title || 'Uncategorized')))].sort();
        let currentBlock = 100;
        for (const cat of categories) {
            categoryNextNumber.set(cat, currentBlock);
            currentBlock += 100;
        }
    } else if (numberingMode === 'custom-ranges') {
        for (const [cat, startNum] of Object.entries(customRanges)) {
            categoryNextNumber.set(cat, Number(startNum) || 100);
        }
    } else {
        const currentMax = dbChannels.reduce((max: number, ch: any) => {
            const num = Number(ch.channel_number) || 0;
            return num >= STARTING_CHANNEL_NUMBER ? Math.max(max, num) : max;
        }, 0);
        if (currentMax > 0) nextNumber = currentMax + 1;
    }

    emitProgress('Initializing matching...', 0, total, 'match');

    const overridesRes = await db.execute("SELECT * FROM manual_overrides");
    const overrides = new Map(overridesRes.rows.map(r => [r.channel_id, r.epg_id]));

    // Accumulate batch DB writes
    let matchUpdates: { sql: string; args: any[] }[] = [];
    let numberUpdates: { sql: string; args: any[] }[] = [];

    for (let i = 0; i < total; i++) {
        const ch = matchingChannels[i];
        const tvgId = String(ch.tvg_id || '').toLowerCase();
        const chanName = String(ch.name || '').substring(0, 30);

        // Candidates map: xmltv_id -> { candidate, score, reason }
        const candidates = new Map<string, { candidate: any; score: number; reason: string }>();

        const addCandidate = (candidate: any, type: string, fuseScore = 1.0) => {
            if (!candidate || !candidate.xmltv_id) return;
            const res = calculateMatchScore(ch, candidate, type, fuseScore);
            const existing = candidates.get(candidate.xmltv_id);
            if (!existing || res.score > existing.score) {
                candidates.set(candidate.xmltv_id, { candidate, score: res.score, reason: res.reason });
            }
        };

        // Manual Override (always gets high priority)
        if (overrides.has(ch.id)) {
            const oid = String(overrides.get(ch.id)).toLowerCase();
            if (idMap.has(oid)) {
                candidates.set(oid, { candidate: idMap.get(oid), score: 10.0, reason: "Manual Override" });
            }
        }

        // Existing Confirmed Match
        if (ch.matched_epg_id) {
            const meid = String(ch.matched_epg_id).toLowerCase();
            if (idMap.has(meid)) {
                let reason = ch.match_type ? String(ch.match_type) : "Confirmed Match";
                if (!reason.includes("(Confirmed)")) reason += " (Confirmed)";
                candidates.set(meid, { candidate: idMap.get(meid), score: 5.0, reason });
            }
        }

        // 1. Exact tvg-id match
        if (tvgId && idMap.has(tvgId)) {
            addCandidate(idMap.get(tvgId), 'exact_id');
        }

        // 2. Normalized tvg-id match
        if (tvgId) {
            const baseId = normalizeId(tvgId);
            if (baseId && normalizedIdMap.has(baseId)) {
                addCandidate(normalizedIdMap.get(baseId), 'normalized_id');
            }
        }

        // 3. tvg_name match
        if (ch.tvg_name) {
            const cTvgName = cleanName(String(ch.tvg_name)).toLowerCase();
            if (cTvgName && nameMap.has(cTvgName)) {
                addCandidate(nameMap.get(cTvgName), 'exact_name');
            }
            const baseTvgName = normalizeId(String(ch.tvg_name));
            if (baseTvgName && normalizedIdMap.has(baseTvgName)) {
                addCandidate(normalizedIdMap.get(baseTvgName), 'normalized_id');
            }
        }

        // 4. Exact Name match
        const cName = cleanName(String(ch.name || '')).toLowerCase();
        if (cName && nameMap.has(cName)) {
            addCandidate(nameMap.get(cName), 'exact_name');
        }

        // 5. Word-order agnostic name match
        if (cName) {
            const wordKey = cName.split(/\s+/).sort().join(' ');
            if (nameWordMap.has(wordKey)) {
                addCandidate(nameWordMap.get(wordKey), 'word_order');
            }
        }

        // 6. Fuzzy Name match (Fuse.js) — only if no high-confidence match (score >= 0.80) found yet
        let currentBest = 0;
        for (const c of candidates.values()) {
            if (c.score > currentBest) currentBest = c.score;
        }

        if (currentBest < 0.80) {
            const cNameClean = cleanName(String(ch.name || ''));
            if (cNameClean) {
                const fuzzyResults = iptvFuse.search(cNameClean);
                for (const r of fuzzyResults.slice(0, 3)) {
                    if ((r.score as number) <= 0.40) {
                        addCandidate(r.item, 'fuzzy', r.score as number);
                    }
                }
            }
        }

        // Find the candidate with the highest score
        let bestMatch: any = null;
        let bestScore = -999.0;
        let bestReason = "";

        for (const [xmltvId, item] of candidates.entries()) {
            if (item.score > bestScore) {
                bestScore = item.score;
                bestMatch = item.candidate;
                bestReason = item.reason;
            }
        }

        const matched = bestMatch && bestScore >= 0.58;
        const matchedEpgId = matched ? bestMatch.xmltv_id : "";
        const matchReason = matched ? (bestScore >= 5.0 ? bestReason : `Score: ${bestScore.toFixed(2)} (${bestReason})`) : "";

        // Handle auto-numbering
        let channelNumber = ch.channel_number;
        const originalChannelNumber = channelNumber;
        
        if (numberingMode !== 'list' || !channelNumber) {
            if (numberingMode === 'auto-group' || numberingMode === 'custom-ranges') {
                const group = String(ch.group_title || 'Uncategorized');
                if (!categoryNextNumber.has(group)) {
                    categoryNextNumber.set(group, nextNumber);
                    nextNumber += 100;
                }
                channelNumber = categoryNextNumber.get(group)!;
                categoryNextNumber.set(group, channelNumber + 1);
            } else {
                if (!channelNumber) channelNumber = nextNumber++;
            }
        }

        // Batch DB writes
        if (matched) {
            matchedCount++;
            if (onMatch && matchedEpgId && ch.enabled === 1 && bestMatch.site && bestMatch.site_id) {
                pendingGrabIds.push(matchedEpgId);
                if (pendingGrabIds.length >= GRAB_BATCH_SIZE) {
                    onMatch([...pendingGrabIds]);
                    pendingGrabIds.length = 0;
                }
            }

            matchUpdates.push({
                sql: "UPDATE channels SET matched_epg_id = ?, match_type = ?, channel_number = ? WHERE id = ?",
                args: [matchedEpgId, matchReason, channelNumber, ch.id]
            });
        } else if (channelNumber !== originalChannelNumber) {
            numberUpdates.push({
                sql: "UPDATE channels SET channel_number = ? WHERE id = ?",
                args: [channelNumber, ch.id]
            });
        }

        // Flush batched writes every UPDATE_BATCH_SIZE channels
        if (matchUpdates.length >= UPDATE_BATCH_SIZE) {
            await executeBatchUpdates(matchUpdates);
            matchUpdates = [];
        }
        if (numberUpdates.length >= UPDATE_BATCH_SIZE) {
            await executeBatchUpdates(numberUpdates);
            numberUpdates = [];
        }

        // Progress updates
        if ((i + 1) % 20 === 0 || i === total - 1) {
            const unmatchedCount = (i + 1) - matchedCount;
            emitProgress(`Matching... ${matchedCount} matched, ${unmatchedCount} unmatched (${i + 1}/${total}) [${chanName}] - ${matchReason || 'no match'}`, i + 1, total, 'match');
        }
        if ((i + 1) % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    // Flush remaining batched writes
    if (matchUpdates.length > 0) await executeBatchUpdates(matchUpdates);
    if (numberUpdates.length > 0) await executeBatchUpdates(numberUpdates);

    // Flush remaining grab IDs
    if (onMatch && pendingGrabIds.length > 0) {
        onMatch([...pendingGrabIds]);
        pendingGrabIds.length = 0;
    }

    categoryNextNumber.clear();
    clearIptvOrgCache();

    const finalUnmatched = total - matchedCount;
    emitLog(`Full channel matching complete: ${matchedCount} matched, ${finalUnmatched} unmatched of ${total} total channels.`, "success");
    emitProgressComplete('match', `Matching complete: ${matchedCount} matched, ${finalUnmatched} unmatched (${total}/${total})`, total);
    return matchedCount;
}

async function executeBatchUpdates(updates: { sql: string; args: any[] }[]) {
    if (updates.length === 0) return;
    try {
        await db.execute('BEGIN TRANSACTION');
        for (const u of updates) {
            await db.execute({ sql: u.sql, args: u.args });
        }
        await db.execute('COMMIT');
    } catch (err: any) {
        emitLog(`Batch update failed: ${err.message}`, "error");
        try { await db.execute('ROLLBACK'); } catch (_) {}
    }
}


/**
 * Cleanup EPG data - remove expired programs and orphaned entries
 */
export async function cleanupEpgData(): Promise<{ expiredRemoved: number, orphanedRemoved: number }> {
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
export async function generatePlaylistAndEpg(): Promise<{ playlistCount: number, epgChannels: number, epgPrograms: number }> {
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
    // Written through a temp file and renamed: a player fetching /playlist.m3u
    // mid-rebuild used to receive whatever had been flushed so far.
    writeFileAtomic(path.join(DB_DIR, 'playlist.m3u'), m3u);
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

        // The id set goes into a table rather than being interpolated into the
        // SQL. It used to be built by hand-escaping quotes into a literal
        // `IN (...)` list — around 40 KB of SQL for 1,500 channels, and correct
        // only for as long as the escaping was.
        await db.execute(`CREATE TABLE IF NOT EXISTS export_channel_ids (id TEXT PRIMARY KEY)`);
        await db.execute(`DELETE FROM export_channel_ids`);
        for (let i = 0; i < allEpgIds.length; i += 500) {
            const batch = allEpgIds.slice(i, i + 500);
            await db.execute({
                sql: `INSERT OR IGNORE INTO export_channel_ids (id) VALUES ${batch.map(() => '(?)').join(',')}`,
                args: batch
            });
        }

        const stream = createAtomicWriteStream(path.join(DB_DIR, 'epg.xml'));
        try {
            await stream.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');

            // First, write channel info from epg_channels table (if available)
            const epgChannelsData = await db.execute(
                `SELECT * FROM epg_channels WHERE id IN (SELECT id FROM export_channel_ids)`
            );
            const epgChannelMap = new Map(epgChannelsData.rows.map(c => [String(c.id), c]));

            // Write all channel entries - use epg_channels data if available, otherwise use playlist data
            for (const ch of epgChannelList) {
                const epgData = epgChannelMap.get(String(ch.id));
                const displayName = epgData?.display_name || ch.name;
                const icon = epgData?.icon || ch.logo;
                let channelXml = `  <channel id="${getText(ch.id)}"><display-name>${getText(displayName)}</display-name>`;
                if (icon) channelXml += `<icon src="${getText(icon)}" />`;
                channelXml += `</channel>\n`;
                await stream.write(channelXml);
            }

            // Get total program count for progress
            const countRes = await db.execute(
                `SELECT COUNT(*) as c FROM epg_programs WHERE channel_id IN (SELECT id FROM export_channel_ids)`
            );
            epgProgramCount = Number(countRes.rows[0].c);
            emitLog(`Writing ${epgProgramCount.toLocaleString()} programs to epg.xml...`, "info");

            // Write programs in batches - join with TVMaze cache for enriched metadata
            let written = 0;
            for (let offset = 0; offset < epgProgramCount; offset += 5000) {
                const progs = await db.execute({
                    // ORDER BY is required, not cosmetic: LIMIT/OFFSET without one
                    // has no defined order in SQLite, so successive pages could
                    // repeat rows and skip others. That is why the programme count
                    // in the file did not have to match the count in the database.
                    sql: `
                        SELECT p.*,
                               tc.genres as tvmaze_genres,
                               tc.rating as tvmaze_rating
                        FROM epg_programs p
                        LEFT JOIN tvmaze_cache tc ON p.tmdb_id = tc.tvmaze_id
                        WHERE p.channel_id IN (SELECT id FROM export_channel_ids)
                        ORDER BY p.channel_id, p.start, p.title
                        LIMIT 5000 OFFSET ?
                    `,
                    args: [offset]
                });
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
                    await stream.write(xml);
                }
                written += progs.rows.length;
            }

            await stream.write('</tv>');
            await stream.commit();

            // The count is what was actually written, not what was expected.
            if (written !== epgProgramCount) {
                emitLog(`epg.xml wrote ${written.toLocaleString()} of ${epgProgramCount.toLocaleString()} expected programmes`, "warning");
            }
            epgProgramCount = written;
        } catch (e: any) {
            // The previous epg.xml stays in place rather than being replaced by
            // a truncated one.
            await stream.abort();
            emitLog(`epg.xml generation failed, previous file kept: ${e.message}`, "error");
            throw e;
        } finally {
            await db.execute(`DELETE FROM export_channel_ids`).catch(() => { /* best effort */ });
        }
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
