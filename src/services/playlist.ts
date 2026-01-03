import axios from 'axios';
import { parse } from 'iptv-playlist-parser';
import { db, getSetting } from '../db';
import { createHash } from 'crypto';
import { Row } from '@libsql/client';
import { emitLog, emitProgress } from '../events';

export interface PlaylistCategory {
    name: string;
    id: string; // url or identifier
    type: 'category' | 'country' | 'language';
}

export async function getPlaylistCategories(): Promise<PlaylistCategory[]> {
    // We will aggregate categories and countries
    const [cats, countries] = await Promise.all([
        axios.get('https://iptv-org.github.io/api/categories.json'),
        axios.get('https://iptv-org.github.io/api/countries.json')
    ]);

    const result: PlaylistCategory[] = [];
    
    // https://iptv-org.github.io/iptv/categories/{id}.m3u
    result.push(...cats.data.map((c: any) => ({
        name: c.name,
        id: `https://iptv-org.github.io/iptv/categories/${c.id}.m3u`,
        type: 'category' as const
    })));

    // https://iptv-org.github.io/iptv/countries/{id}.m3u
    result.push(...countries.data.map((c: any) => ({
        name: c.name,
        id: `https://iptv-org.github.io/iptv/countries/${c.code.toLowerCase()}.m3u`,
        type: 'country' as const
    })));

    return result;
}

function generateId(url: string, name: string): string {
    return createHash('md5').update(url + name).digest('hex');
}

export async function fetchAndSavePlaylist(url: string) {
    emitLog(`Fetching playlist: ${url}`, "info");
    const resp = await axios.get(url);
    const parsed = parse(resp.data);
    
    emitLog(`Parsing ${parsed.items.length} channels...`, "info");
    // Get existing channel IDs to avoid duplicates and track what to delete
    const existingIdsRes = await db.execute("SELECT id, channel_number FROM channels");
    const existingMap = new Map(existingIdsRes.rows.map(r => [String(r.id), Number(r.channel_number)]));
    
    // Find highest channel number (starting at 700)
    const STARTING_CHANNEL_NUMBER = 700;
    let nextChannelNumber = STARTING_CHANNEL_NUMBER;
    if (existingIdsRes.rows.length > 0) {
        const nums = existingIdsRes.rows.map(r => Number(r.channel_number)).filter(n => !isNaN(n) && n >= STARTING_CHANNEL_NUMBER);
        if (nums.length > 0) nextChannelNumber = Math.max(...nums) + 1;
    }

    const channels = parsed.items;
    const seenIds = new Set<string>();

    const batchSize = 100;
    for (let i = 0; i < channels.length; i += batchSize) {
        const chunk = channels.slice(i, i + batchSize);
        
        await db.execute("BEGIN TRANSACTION");
        for (const ch of chunk) {
            const id = generateId(ch.url, ch.name);
            seenIds.add(id);
            const lang = (ch.raw.match(/tvg-language="([^"]+)"/i) || [])[1] || '';
            
            if (existingMap.has(id)) {
                // Update existing
                await db.execute({
                    sql: `UPDATE channels SET 
                            name = ?, 
                            group_title = ?, 
                            url = ?, 
                            tvg_id = ?, 
                            tvg_name = ?, 
                            tvg_logo = ?, 
                            lang = ? 
                          WHERE id = ?`,
                    args: [
                        ch.name, 
                        ch.group.title || '', 
                        ch.url, 
                        ch.tvg.id || '', 
                        ch.tvg.name || '', 
                        ch.tvg.logo || '', 
                        lang, 
                        id
                    ]
                });
            } else {
                // Insert new
                await db.execute({
                    sql: `INSERT INTO channels (id, name, group_title, url, tvg_id, tvg_name, tvg_logo, lang, matched_epg_id, match_type, enabled, channel_number) 
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [
                        id, 
                        ch.name, 
                        ch.group.title || '', 
                        ch.url, 
                        ch.tvg.id || '', 
                        ch.tvg.name || '', 
                        ch.tvg.logo || '', 
                        lang, 
                        null, 
                        null, 
                        1, 
                        nextChannelNumber++
                    ]
                });
            }
        }
        await db.execute("COMMIT");
        if (i > 0 && i % 500 === 0) {
            emitLog(`  Saved ${i}/${channels.length} channels...`, "info");
            emitProgress(`Saving playlist...`, i, channels.length, 'match');
        }
    }
    emitLog(`Playlist update complete. ${channels.length} channels processed.`, "success");
    
    // Optional: Delete channels no longer in playlist? 
    // The requirement says "loaded and updated", so stale data should probably be removed.
    const allIds = Array.from(existingMap.keys());
    const toDelete = allIds.filter(id => !seenIds.has(id));
    if (toDelete.length > 0) {
        const placeholders = toDelete.map(() => "?").join(",");
        await db.execute({
            sql: `DELETE FROM channels WHERE id IN (${placeholders})`,
            args: toDelete
        });
    }

    // Save URL to settings
    await db.execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        args: ["playlist_url", url]
    });
    
    // Trigger Pre-match
    await applyPreMatches();

    return channels.length;
}

export async function applyPreMatches() {
    // Load all channels
    const channels = (await db.execute("SELECT * FROM channels")).rows;
    
    // Load overrides
    const overridesRes = await db.execute("SELECT * FROM manual_overrides");
    const overrides = new Map(overridesRes.rows.map(r => [r.channel_id, r.epg_id]));

    const updates: Promise<any>[] = [];

    for (const channel of channels) {
        let matchId: string | null = null;
        let matchType: string | null = null;

        // 0. Existing match (Confirm)
        if (channel.matched_epg_id) {
            matchId = String(channel.matched_epg_id);
            matchType = channel.match_type ? String(channel.match_type) : "Confirmed Match";
            if (!matchType.includes("(Confirmed)")) matchType += " (Confirmed)";
        } 
        // 1. Override
        else if (overrides.has(channel.id)) {
            matchId = overrides.get(channel.id) as string;
            matchType = "Manual Override";
        } 
        // 2. IPTV-ORG Map
        else if (channel.name) {
            const mapRes = await db.execute({ 
                sql: "SELECT xmltv_id, lang FROM iptv_org_map WHERE name = ? COLLATE NOCASE", 
                args: [channel.name] 
            });
            
            if (mapRes.rows.length > 0) {
                // Determine best match: 
                // 1. Channel specific language (tvg-language)
                // 2. Global preferred language
                // 3. Exact match (null lang)
                
                const preferredLang = await getSetting('preferred_lang');
                const channelLang = channel.lang as string; // From DB

                let bestMatch: Row | undefined | null = mapRes.rows[0];

                // Logic:
                // If channel has lang or preferredLang is set, try to find match with ANY similarity
                
                const targetLang = channelLang || preferredLang;

                if (targetLang) {
                    // Try exact match first
                    const exact = mapRes.rows.find(r => r.lang && String(r.lang).toLowerCase() === String(targetLang).toLowerCase());
                    if (exact) {
                        bestMatch = exact;
                    } else {
                        // If we have a target lang but no match for it, degrade to 'null' lang if no specific match found.
                        // "Strict" matching requested.
                        const generic = mapRes.rows.find(r => !r.lang);
                        bestMatch = generic || null;
                    }
                }
                
                if (bestMatch) {
                    matchId = bestMatch.xmltv_id as string;
                    matchType = "IPTV-ORG Map (Pre-match)";
                }
            }
        }

        if (matchId) {
            updates.push(db.execute({
                sql: "UPDATE channels SET matched_epg_id = ?, match_type = ? WHERE id = ?",
                args: [matchId, matchType, channel.id]
            }));
        }
    }

    if (updates.length > 0) {
        await db.execute("BEGIN TRANSACTION");
        await Promise.all(updates);
        await db.execute("COMMIT");
    }
}
