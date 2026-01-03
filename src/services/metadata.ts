import { db, getSetting } from '../db';
import { emitLog, emitProgress } from '../events';
import axios from 'axios';

// TVMaze API - Free, no API key required!
// https://www.tvmaze.com/api
const TVMAZE_SEARCH_URL = 'https://api.tvmaze.com/singlesearch/shows';

// Simple cache to avoid re-hitting the API for the same titles
const CACHE_TTL_DAYS = 7;

// Rate limiting - TVMaze allows ~20 req/sec, we'll be conservative
const REQUEST_DELAY_MS = 100;

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
async function searchTVMaze(title: string): Promise<TVMazeShow | null> {
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
 * Delay helper for rate limiting
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Enrich all EPG programs with TVMaze metadata
 */
export async function enrichProgramsWithMetadata(): Promise<{
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
        const titlesResult = await db.execute(`
            SELECT DISTINCT title FROM epg_programs 
            WHERE title IS NOT NULL AND title != '' AND enriched = 0
        `);
        const titles = titlesResult.rows.map(r => String(r.title));
        stats.totalPrograms = titles.length;
        
        if (titles.length === 0) {
            emitLog('No programs need enrichment', 'info');
            console.log('[Enrich] No programs need enrichment');
            emitProgress('Enrichment complete - no pending programs', 0, 0, 'enrich');
            return stats;
        }
        
        console.log(`[Enrich] Found ${titles.length} unique show titles to process`);
        emitLog(`Processing ${titles.length} unique show titles via TVMaze API...`, 'info');
        
        const BATCH_SIZE = 25; // Log batch stats every 25 titles
        let batchApiCalls = 0;
        let batchHits = 0;
        let batchMisses = 0;
        let batchCached = 0;
        
        for (let i = 0; i < titles.length; i++) {
            const title = titles[i];
            const normalized = normalizeTitle(title);
            
            // Skip very short normalized titles
            if (!normalized || normalized.length < 2) {
                stats.skipped++;
                console.log(`[Enrich] Skipped: "${title}" (normalized too short)`);
                await db.execute({
                    sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                    args: [title]
                });
                continue;
            }
            
            try {
                // Check cache first
                const cached = await getCachedMetadata(normalized);
                if (cached) {
                    // Use cached data
                    if (cached.tvmaze_id) {
                        await db.execute({
                            sql: `UPDATE epg_programs SET 
                                  tmdb_id = ?,
                                  category = COALESCE(NULLIF(category, ''), ?),
                                  rating = COALESCE(NULLIF(rating, ''), ?),
                                  enriched = 1
                                  WHERE title = ?`,
                            args: [cached.tvmaze_id, cached.genres, cached.rating, title]
                        });
                        stats.enriched++;
                        batchHits++;
                    } else {
                        await db.execute({
                            sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                            args: [title]
                        });
                        stats.notFound++;
                        batchMisses++;
                    }
                    stats.fromCache++;
                    batchCached++;
                    continue;
                }
                
                // Rate limiting delay
                await delay(REQUEST_DELAY_MS);
                
                // Search TVMaze
                apiCalls++;
                batchApiCalls++;
                const show = await searchTVMaze(normalized);
                
                // Cache the result (even if null)
                await cacheMetadata(normalized, show);
                
                if (show) {
                    console.log(`[Enrich] API Hit: "${title}" -> ${show.name} (ID: ${show.id})`);
                    await db.execute({
                        sql: `UPDATE epg_programs SET 
                              tmdb_id = ?,
                              category = COALESCE(NULLIF(category, ''), ?),
                              rating = COALESCE(NULLIF(rating, ''), ?),
                              enriched = 1
                              WHERE title = ?`,
                        args: [
                            show.id,
                            show.genres?.join(', ') || '',
                            show.rating?.average ? String(show.rating.average) : null,
                            title
                        ]
                    });
                    stats.enriched++;
                    batchHits++;
                } else {
                    console.log(`[Enrich] API Miss: "${title}" (not found)`);
                    await db.execute({
                        sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                        args: [title]
                    });
                    stats.notFound++;
                    batchMisses++;
                }
                
            } catch (error: any) {
                apiFailed++;
                console.error(`[Enrich] API Error: "${title}" - ${error.message}`);
                // Mark as processed to avoid retrying on transient errors
                await db.execute({
                    sql: `UPDATE epg_programs SET enriched = 1 WHERE title = ?`,
                    args: [title]
                });
                stats.notFound++;
                batchMisses++;
            }
            
            // Progress and batch logging every BATCH_SIZE titles
            if ((i + 1) % BATCH_SIZE === 0 || i === titles.length - 1) {
                const pct = Math.round(((i + 1) / titles.length) * 100);
                const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                const totalBatches = Math.ceil(titles.length / BATCH_SIZE);
                
                // Batch stats log
                console.log(`[Enrich] Batch ${batchNum}/${totalBatches}: API calls=${batchApiCalls}, hits=${batchHits}, misses=${batchMisses}, cached=${batchCached}`);
                
                // Reset batch counters
                batchApiCalls = 0;
                batchHits = 0;
                batchMisses = 0;
                batchCached = 0;
                
                const msg = `Enriching: ${i + 1}/${titles.length} (${stats.enriched} matched, ${stats.fromCache} cached, ${pct}%)`;
                emitProgress(msg, i + 1, titles.length, 'enrich');
            }
        }
        
        // Final summary
        const endTime = new Date();
        const durationMs = endTime.getTime() - startTime.getTime();
        const durationSec = (durationMs / 1000).toFixed(1);
        
        console.log(`[Enrich] ===== Enrichment completed at ${endTime.toISOString()} =====`);
        console.log(`[Enrich] Duration: ${durationSec}s | Titles: ${titles.length} | API calls: ${apiCalls} | Errors: ${apiFailed}`);
        console.log(`[Enrich] Results: ${stats.enriched} matched, ${stats.notFound} not found, ${stats.skipped} skipped, ${stats.fromCache} from cache`);
        
        const finalMsg = `Enrichment complete: ${stats.enriched} matched, ${stats.notFound} not found, ${stats.skipped} skipped (${durationSec}s)`;
        emitLog(finalMsg, 'success');
        emitProgress(`Complete: ${stats.enriched} matched, ${stats.notFound} not found ✓`, titles.length, titles.length, 'enrich');
        
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
