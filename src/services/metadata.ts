import { db, getSetting } from '../db';
import { emitLog, emitProgress, emitProgressComplete } from '../events';
import axios from 'axios';

// TVMaze API - Free, no API key required!
// https://www.tvmaze.com/api
const TVMAZE_SEARCH_URL = 'https://api.tvmaze.com/singlesearch/shows';

// Simple cache to avoid re-hitting the API for the same titles
const CACHE_TTL_DAYS = 7;

// Rate limiting - TVMaze allows ~20 req/sec, we'll be conservative
const REQUEST_DELAY_MS = 500;

interface TVMazeShow {
    id: number;
    name: string;
    type: string;
    genres: string[];
    rating: { average: number | null };
    summary: string | null;
}

interface CachedMetadata {
    title: string;
    tvmaze_id: number | null;
    genres: string;
    rating: string | null;
    cached_at: number;
}

/**
 * Normalize a title for matching - preserves Unicode letters for non-English
 * Note: If title contains a colon, the first part is treated as the show name
 * and the second part as the episode title (e.g., "The Simpsons: Homer's Odyssey")
 */
export function normalizeTitle(title: string): string {
    // If title contains colon, extract the show name (first part)
    // This handles formats like "Show Name: Episode Title" or "Series: S01E01 Title"
    let showName = title;
    if (title.includes(':')) {
        const parts = title.split(':');
        // Use first part as show name if it's substantial (>2 chars after cleanup)
        const firstPart = parts[0].trim();
        if (firstPart.length > 2) {
            showName = firstPart;
        }
    }

    return showName
        .toLowerCase()
        // Remove quality/format indicators
        .replace(/\b(hd|sd|fhd|uhd|4k|1080p|720p|480p|hevc|h\.?264|x264|x265)\b/gi, '')
        // Remove episode markers
        .replace(/\bs?\d{1,2}[ex]\d{1,2}\b/gi, '')
        .replace(/\bseason\s*\d+\b/gi, '')
        .replace(/\bepisode\s*\d+\b/gi, '')
        // Remove years in parentheses
        .replace(/\(\d{4}\)/g, '')
        // Keep Unicode letters, numbers, and spaces
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Check if metadata enrichment is enabled
 */
export async function isEnrichmentEnabled(): Promise<boolean> {
    const enabled = await getSetting('metadata_enrichment_enabled');
    return enabled === 'true';
}

/**
 * Create metadata cache table if not exists
 */
async function ensureCacheTable(): Promise<void> {
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

/**
 * Get cached metadata for a title
 */
async function getCachedMetadata(normalizedTitle: string): Promise<CachedMetadata | null> {
    const result = await db.execute({
        sql: `SELECT * FROM tvmaze_cache WHERE title_normalized = ?`,
        args: [normalizedTitle]
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const cachedAt = Number(row.cached_at);
    const ageMs = Date.now() - cachedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Return null if cache is expired
    if (ageDays > CACHE_TTL_DAYS) return null;

    return {
        title: normalizedTitle,
        tvmaze_id: row.tvmaze_id ? Number(row.tvmaze_id) : null,
        genres: String(row.genres || ''),
        rating: row.rating ? String(row.rating) : null,
        cached_at: cachedAt
    };
}

/**
 * Cache metadata for a title
 */
async function cacheMetadata(normalizedTitle: string, show: TVMazeShow | null): Promise<void> {
    await db.execute({
        sql: `INSERT OR REPLACE INTO tvmaze_cache (title_normalized, tvmaze_id, genres, rating, cached_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
            normalizedTitle,
            show?.id || null,
            show?.genres?.join(', ') || '',
            show?.rating?.average ? String(show.rating.average) : null,
            Date.now()
        ]
    });
}

/**
 * Search TVMaze for a show
 */
export async function searchTVMaze(title: string): Promise<TVMazeShow | null> {
    try {
        const response = await axios.get<TVMazeShow>(TVMAZE_SEARCH_URL, {
            params: { q: title },
            timeout: 10000
        });
        return response.data;
    } catch (error: any) {
        if (error.response?.status === 404) {
            return null; // No match found
        }
        throw error;
    }
}

/**
 * Search TVMaze for a list of shows
 */
export async function searchTVMazeShows(query: string): Promise<TVMazeShow[]> {
    try {
        const response = await axios.get<any[]>('https://api.tvmaze.com/search/shows', {
            params: { q: query },
            timeout: 10000
        });
        return response.data.map((item: any) => item.show);
    } catch (error: any) {
        console.error("TVMaze search failed:", error.message);
        return [];
    }
}

/**
 * Delay helper for rate limiting
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simple helper to run a set of asynchronous tasks with a maximum concurrency limit.
 */
async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number
): Promise<T[]> {
    const results: T[] = [];
    let currentIndex = 0;

    async function worker() {
        while (currentIndex < tasks.length) {
            const index = currentIndex++;
            results[index] = await tasks[index]();
        }
    }

    const workers = Array(Math.min(concurrency, tasks.length))
        .fill(null)
        .map(() => worker());

    await Promise.all(workers);
    return results;
}

/**
 * Enrich EPG programs with TVMaze metadata.
 * If channelId is provided, only enriches programs for that specific channel (used by pipeline queue).
 */
export async function enrichProgramsWithMetadata(channelId?: string): Promise<{
    totalPrograms: number;
    enriched: number;
    notFound: number;
    skipped: number;
    fromCache: number;
}> {
    const stats = { totalPrograms: 0, enriched: 0, notFound: 0, skipped: 0, fromCache: 0 };
    const startTime = new Date();
    let apiCalls = 0;
    let apiFailed = 0;

    const enabled = await getSetting('metadata_enrichment_enabled');
    if (enabled !== 'true') {
        emitLog('Metadata enrichment is disabled', 'info');
        console.log('[Enrich] Metadata enrichment is disabled');
        return stats;
    }

    console.log(`[Enrich] ===== Starting TVMaze enrichment at ${startTime.toISOString()} =====`);
    emitLog('Starting TVMaze metadata enrichment...', 'info');

    try {
        await ensureCacheTable();

        // Get unique titles that need enrichment
        let titlesQuery = `
            SELECT DISTINCT title FROM epg_programs 
            WHERE title IS NOT NULL AND title != '' AND enriched = 0
        `;
        let titlesArgs: string[] = [];

        if (channelId) {
            titlesQuery += ` AND channel_id = ?`;
            titlesArgs.push(channelId);
        }

        const titlesResult = await db.execute({
            sql: titlesQuery,
            args: titlesArgs
        });
        const titles = titlesResult.rows.map(r => String(r.title));
        stats.totalPrograms = titles.length;

        if (titles.length === 0) {
            if (!channelId) {
                emitLog('No programs need enrichment', 'info');
                console.log('[Enrich] No programs need enrichment');
                emitProgressComplete('enrich', 'Enrichment complete - no pending programs', 0);
            }
            return stats;
        }

        console.log(`[Enrich] Found ${titles.length} unique show titles to process${channelId ? ` for channel ${channelId}` : ''}`);
        if (!channelId) {
            emitLog(`Processing ${titles.length} unique show titles via TVMaze API...`, 'info');
        }

        // Create mapping of original title to normalized title
        const titleMap = new Map<string, string>();
        const uniqueNormalized = new Set<string>();
        for (const title of titles) {
            const normalized = normalizeTitle(title);
            if (normalized && normalized.length >= 2) {
                titleMap.set(title, normalized);
                uniqueNormalized.add(normalized);
            } else {
                stats.skipped++;
                await db.execute({
                    sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                    args: [title]
                });
            }
        }

        if (titleMap.size === 0) {
            return stats;
        }

        const normalizedList = Array.from(uniqueNormalized);

        // Fetch overrides for all unique normalized titles
        const overridesMap = new Map<string, any>();
        const chunkSize = 200;
        for (let i = 0; i < normalizedList.length; i += chunkSize) {
            const chunk = normalizedList.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            const res = await db.execute({
                sql: `SELECT * FROM metadata_overrides WHERE title_normalized IN (${placeholders})`,
                args: chunk
            });
            for (const row of res.rows) {
                overridesMap.set(String(row.title_normalized), row);
            }
        }

        // Fetch TVMaze cache for all unique normalized titles
        const cacheMap = new Map<string, CachedMetadata>();
        for (let i = 0; i < normalizedList.length; i += chunkSize) {
            const chunk = normalizedList.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            const res = await db.execute({
                sql: `SELECT * FROM tvmaze_cache WHERE title_normalized IN (${placeholders})`,
                args: chunk
            });
            for (const row of res.rows) {
                const cachedAt = Number(row.cached_at);
                const ageMs = Date.now() - cachedAt;
                const ageDays = ageMs / (1000 * 60 * 60 * 24);
                if (ageDays <= CACHE_TTL_DAYS) {
                    cacheMap.set(String(row.title_normalized), {
                        title: String(row.title_normalized),
                        tvmaze_id: row.tvmaze_id ? Number(row.tvmaze_id) : null,
                        genres: String(row.genres || ''),
                        rating: row.rating ? String(row.rating) : null,
                        cached_at: cachedAt
                    });
                }
            }
        }

        const updates: { sql: string; args: any[] }[] = [];
        const cacheMisses: string[] = [];

        // Determine updates and cache misses
        for (const [title, normalized] of titleMap.entries()) {
            if (overridesMap.has(normalized)) {
                const override = overridesMap.get(normalized);
                updates.push({
                    sql: `UPDATE epg_programs SET tmdb_id = ?, category = COALESCE(NULLIF(category, ''), ?), rating = COALESCE(NULLIF(rating, ''), ?), enriched = 1 WHERE title = ?`,
                    args: [override.tvmaze_id, override.genres, override.rating, title]
                });
                stats.enriched++;
            } else if (cacheMap.has(normalized)) {
                const cached = cacheMap.get(normalized)!;
                if (cached.tvmaze_id) {
                    updates.push({
                        sql: `UPDATE epg_programs SET tmdb_id = ?, category = COALESCE(NULLIF(category, ''), ?), rating = COALESCE(NULLIF(rating, ''), ?), enriched = 1 WHERE title = ?`,
                        args: [cached.tvmaze_id, cached.genres, cached.rating, title]
                    });
                    stats.enriched++;
                } else {
                    updates.push({
                        sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                        args: [title]
                    });
                    stats.notFound++;
                }
                stats.fromCache++;
            } else {
                if (!cacheMisses.includes(normalized)) {
                    cacheMisses.push(normalized);
                }
            }
        }

        // Process cache misses sequentially with delay
        let processedCount = stats.fromCache + stats.skipped;
        for (const normalized of cacheMisses) {
            try {
                await delay(REQUEST_DELAY_MS);
                apiCalls++;
                const show = await searchTVMaze(normalized);
                await cacheMetadata(normalized, show);

                for (const [title, norm] of titleMap.entries()) {
                    if (norm === normalized) {
                        if (show) {
                            updates.push({
                                sql: `UPDATE epg_programs SET tmdb_id = ?, category = COALESCE(NULLIF(category, ''), ?), rating = COALESCE(NULLIF(rating, ''), ?), enriched = 1 WHERE title = ?`,
                                args: [show.id, show.genres?.join(', ') || '', show.rating?.average ? String(show.rating.average) : null, title]
                            });
                            stats.enriched++;
                        } else {
                            updates.push({
                                sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                                args: [title]
                            });
                            stats.notFound++;
                        }
                    }
                }
            } catch (err) {
                apiFailed++;
                for (const [title, norm] of titleMap.entries()) {
                    if (norm === normalized) {
                        updates.push({
                            sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                            args: [title]
                        });
                        stats.notFound++;
                    }
                }
            }
            
            processedCount++;
            if (processedCount % 10 === 0 || processedCount === titles.length) {
                const prefix = channelId ? `[Channel ${channelId}] ` : '';
                emitProgress(`${prefix}Enriching: ${processedCount}/${titles.length} programs`, processedCount, titles.length, 'enrich');
            }
        }

        // Execute all updates inside a single database transaction!
        if (updates.length > 0) {
            await db.execute("BEGIN TRANSACTION");
            for (const update of updates) {
                await db.execute({ sql: update.sql, args: update.args });
            }
            await db.execute("COMMIT");
        }

        const endTime = new Date();
        const durationMs = endTime.getTime() - startTime.getTime();
        const durationSec = (durationMs / 1000).toFixed(1);

        console.log(`[Enrich] ===== Enrichment completed at ${endTime.toISOString()} =====`);
        console.log(`[Enrich] Duration: ${durationSec}s | Titles: ${titles.length} | API calls: ${apiCalls} | Errors: ${apiFailed}`);
        console.log(`[Enrich] Results: ${stats.enriched} matched, ${stats.notFound} not found, ${stats.skipped} skipped, ${stats.fromCache} from cache`);

        if (!channelId) {
            const finalMsg = `Enrichment complete: ${stats.enriched} matched, ${stats.notFound} not found, ${stats.skipped} skipped (${durationSec}s)`;
            emitLog(finalMsg, 'success');
            emitProgressComplete('enrich', `Complete: ${stats.enriched} matched, ${stats.notFound} not found ✓`, titles.length);
        }

    } catch (error: any) {
        console.error(`[Enrich] Fatal error: ${error.message}`);
        emitLog(`Metadata enrichment failed: ${error.message}`, 'error');
    }

    return stats;
}


/**
 * Get enrichment statistics
 */
export async function getEnrichmentStats(): Promise<{
    cachedShows: number;
    enrichedPrograms: number;
    pendingPrograms: number;
    imdbDataAge: string;
}> {
    let cachedShows = 0;

    try {
        const cacheRes = await db.execute("SELECT COUNT(*) as c FROM tvmaze_cache");
        cachedShows = Number(cacheRes.rows[0].c);
    } catch (e) {
        // Table might not exist yet
    }

    const [enrichedRes, pendingRes] = await Promise.all([
        db.execute('SELECT COUNT(*) as c FROM epg_programs WHERE enriched = 1'),
        db.execute('SELECT COUNT(*) as c FROM epg_programs WHERE enriched = 0')
    ]);

    return {
        cachedShows,
        enrichedPrograms: Number(enrichedRes.rows[0].c),
        pendingPrograms: Number(pendingRes.rows[0].c),
        imdbDataAge: 'TVMaze API (live)' // No longer using IMDb
    };
}

/**
 * Clear enrichment status (programs will be re-enriched)
 */
export async function clearMetadataCache(): Promise<void> {
    await db.execute('UPDATE epg_programs SET enriched = 0, tmdb_id = NULL, tmdb_poster = NULL');
    try {
        await db.execute('DELETE FROM tvmaze_cache');
    } catch (e) {
        // Table might not exist
    }
    emitLog('Enrichment cache cleared', 'info');
    console.log('[Enrich] Enrichment cache cleared');
}

/**
 * Force refresh - clears cache and re-enriches
 */
export async function refreshImdbData(): Promise<void> {
    await clearMetadataCache();
    await enrichProgramsWithMetadata();
}
