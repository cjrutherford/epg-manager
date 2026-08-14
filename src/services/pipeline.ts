import { db } from '../db';
import { emitLog, emitProgress, emitProgressComplete } from '../events';
import { grabChannel } from './grabber';
import { enrichProgramsWithMetadata } from './metadata';
import { formatMemorySnapshot } from './memory';
import { filterNewQueueIds, getGrabBatchSizeForSite, prioritizeGrabSites } from './pipeline-utils';

export class PipelineQueue {
    // Group tasks by site for batched grabs
    private grabBatches = new Map<string, { xmltvId: string; site_id: string; lang: string }[]>();
    private enrichQueue: string[] = [];
    private isCancelled = false;
    private queuedGrabIds = new Set<string>();
    private queuedEnrichIds = new Set<string>();

    // Concurrency tracking
    private activeGrabs = 0;
    private activeEnriches = 0;
    private isProcessingGrabQueue = false;

    // Configurable limits — lowered to reduce peak memory pressure
    // during concurrent EPG grabs and TVMaze enrichment
    private readonly MAX_CONCURRENT_GRABS = 1;
    private readonly MAX_CONCURRENT_ENRICHES = 1;

    // Stats and Progress
    private totalMatched = 0;
    private matchProgress = 0;

    private totalToGrab = 0;
    /** Matched channels no enabled grab-capable source covers. */
    private noSourceIds = new Set<string>();
    private grabsCompleted = 0;
    private grabsSuccessful = 0;
    private grabsFailed = 0;

    private totalToEnrich = 0;
    private enrichesCompleted = 0;
    private enrichesSuccessful = 0;

    private epgDays: string;

    // Promise management to allow awaiting the whole pipeline
    private isMatchingComplete = false;
    private resolvePipeline!: () => void;
    private pipelinePromise: Promise<void>;

    constructor(epgDays: string) {
        this.epgDays = epgDays;
        this.pipelinePromise = new Promise((resolve) => {
            this.resolvePipeline = resolve;
        });
    }

    public async enqueueMatched(xmltvIds: string[]) {
        if (this.isCancelled) return;
        const uniqueIds = filterNewQueueIds(xmltvIds, this.queuedGrabIds);
        if (uniqueIds.length === 0) return;

        this.totalMatched += uniqueIds.length;
        // totalToGrab is incremented per resolved id below, not here. Counting
        // every id up front meant channels with no grab-capable source were
        // included in the denominator but never queued, so grabsCompleted could
        // never reach totalToGrab and the phase never rendered as complete (R5).
        emitLog(formatMemorySnapshot('pipeline enqueue matched', process.memoryUsage(), {
            queued: uniqueIds.length,
            totalQueued: this.totalToGrab,
            uniqueQueuedIds: this.queuedGrabIds.size
        }), 'info');

        const chunkSize = 500;
        for (let i = 0; i < uniqueIds.length; i += chunkSize) {
            const chunk = uniqueIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            // Get the best currently enabled grab source for each channel.
            const res = await db.execute({
                sql: `
                    SELECT esc.xmltv_id, esc.site, esc.site_id, esc.lang
                    FROM epg_source_channels esc
                    JOIN sources es ON es.key = esc.source_key
                    LEFT JOIN channel_site_status css
                      ON css.xmltv_id = esc.xmltv_id AND css.site = esc.site
                    WHERE esc.xmltv_id IN (${placeholders})
                    AND es.enabled = 1
                    AND es.grab_capable = 1
                    AND esc.site IS NOT NULL
                    AND esc.site_id IS NOT NULL
                    ORDER BY
                      CASE WHEN (COALESCE(css.success_count, 0) + COALESCE(css.failure_count, 0)) > 0
                        THEN CAST(COALESCE(css.success_count, 0) AS REAL) / (COALESCE(css.success_count, 0) + COALESCE(css.failure_count, 0))
                        ELSE 0.5
                      END DESC,
                      COALESCE(css.last_program_count, 0) DESC,
                      es.priority DESC,
                      COALESCE(es.channel_count_estimate, 0) DESC,
                      esc.site ASC
                `,
                args: chunk
            });
            
            const selectedXmltvIds = new Set<string>();
            for (let row of res.rows) {
                const xmltvId = String(row.xmltv_id);
                if (selectedXmltvIds.has(xmltvId)) continue;
                selectedXmltvIds.add(xmltvId);
                const site = String(row.site);
                if (!this.grabBatches.has(site)) {
                    this.grabBatches.set(site, []);
                }
                this.grabBatches.get(site)!.push({
                    xmltvId,
                    site_id: String(row.site_id),
                    lang: String(row.lang || 'en')
                });
            }

            // Only what is actually queued counts toward the total.
            this.totalToGrab += selectedXmltvIds.size;

            // The rest have no enabled, grab-capable source covering them. That
            // is a real and useful outcome — it is the answer to "why does this
            // channel have no guide?" — so it is reported rather than absorbed.
            for (const id of chunk) {
                if (!selectedXmltvIds.has(id)) {
                    this.noSourceIds.add(id);
                }
            }
        }

        this.processGrabQueue();
        this.emitGrabProgress();
    }

    private hasEnrichedExistingChannels = false;

    public async setMatchingComplete(totalScanned: number, totalMatched: number, totalUnmatched?: number) {
        this.isMatchingComplete = true;
        this.totalMatched = totalMatched;
        this.matchProgress = totalScanned;

        // Ensure ALL matched and enabled channels across all sources (including FAST presets) are queued for EPG grab
        try {
            const allMatchedRes = await db.execute(`
                SELECT DISTINCT COALESCE(mo.epg_id, c.matched_epg_id, c.tvg_id) as xmltv_id
                FROM channels c
                LEFT JOIN manual_overrides mo ON c.id = mo.channel_id
                WHERE c.enabled = 1 AND (c.matched_epg_id IS NOT NULL AND c.matched_epg_id != '' OR mo.epg_id IS NOT NULL AND mo.epg_id != '' OR c.tvg_id IS NOT NULL AND c.tvg_id != '')
            `);
            const allMatchedIds = allMatchedRes.rows.map(r => String(r.xmltv_id)).filter(Boolean);
            if (allMatchedIds.length > 0) {
                await this.enqueueMatched(allMatchedIds);
            }
        } catch (e: any) {
            console.error('[Pipeline] Error auto-queuing all matched channels for grab:', e.message);
        }

        const unmatched = totalUnmatched !== undefined ? totalUnmatched : Math.max(0, totalScanned - totalMatched);
        emitProgressComplete('match', `Matching complete: ${totalMatched} matched, ${unmatched} unmatched (${totalScanned}/${totalScanned})`, totalScanned);

        this.emitGrabProgress();
        this.checkPipelineComplete();
    }

    private async enrichAllExistingChannels() {
        try {
            const result = await db.execute(`
                SELECT DISTINCT p.channel_id
                FROM epg_programs p
                LEFT JOIN epg_programs unriched ON p.channel_id = unriched.channel_id AND unriched.enriched = 0
                WHERE p.channel_id IS NOT NULL
                GROUP BY p.channel_id
                HAVING COUNT(*) > 0
            `);

            const channelIds = result.rows.map(r => String(r.channel_id)).filter(Boolean);

            if (channelIds.length === 0) {
                return;
            }

            const freshIds = filterNewQueueIds(channelIds, this.queuedEnrichIds);
            for (const id of freshIds) {
                this.totalToEnrich++;
                this.enrichQueue.push(id);
            }

            this.processEnrichQueue();
        } catch (err: any) {
            console.error('[Pipeline] Error queuing existing channels for enrichment:', err.message);
        }
    }

    public waitForCompletion(): Promise<void> {
        this.checkPipelineComplete();
        return this.pipelinePromise;
    }

    private processGrabQueue() {
        if (this.isProcessingGrabQueue || this.isCancelled) return;
        this.isProcessingGrabQueue = true;

        try {
            while (!this.isCancelled && this.activeGrabs < this.MAX_CONCURRENT_GRABS && this.grabBatches.size > 0) {
                // Pick a site that has a batch to process
                const orderedSites = prioritizeGrabSites(Array.from(this.grabBatches.keys()));
                const nextSite = orderedSites[0];
                if (!nextSite) break;

                const channels = this.grabBatches.get(nextSite)!;
                const batchSize = Math.min(channels.length, getGrabBatchSizeForSite(nextSite));
                const batch = channels.splice(0, batchSize);
                
                // If this site has no more channels, remove it from the map
                if (channels.length === 0) {
                    this.grabBatches.delete(nextSite);
                }

                this.activeGrabs++;
                this.emitGrabProgress();

                emitLog(`[Pipeline] Grabbing EPG batch for site ${nextSite} (${batch.length} channels)`, 'info');
                emitLog(formatMemorySnapshot('pipeline site batch start', process.memoryUsage(), {
                    site: nextSite,
                    batch: batch.length,
                    remainingSites: this.grabBatches.size,
                    epgDays: this.epgDays
                }), 'info');

                // Call the batched grabber
                import('./grabber.js').then(({ grabSiteBatch }) => {
                    if (this.isCancelled) {
                        this.activeGrabs--;
                        this.checkPipelineComplete();
                        return;
                    }
                    grabSiteBatch(nextSite, batch, this.epgDays)
                        .then((results: any[]) => {
                            if (this.isCancelled) return;
                            for (const res of results) {
                                if (res.success) {
                                    this.grabsSuccessful++;
                                    const freshEnrichIds = filterNewQueueIds([res.xmltvId], this.queuedEnrichIds);
                                    if (freshEnrichIds.length > 0) {
                                        this.totalToEnrich++;
                                        this.enrichQueue.push(freshEnrichIds[0]);
                                    }
                                } else {
                                    this.grabsFailed++;
                                }
                                this.grabsCompleted++;
                            }
                            this.processEnrichQueue();
                        }).catch((err: any) => {
                            // If the whole site command fails, mark all as failed
                            this.grabsFailed += batch.length;
                            this.grabsCompleted += batch.length;
                            emitLog(`[Pipeline] Grab error for site ${nextSite}: ${err.message}`, 'error');
                        }).finally(() => {
                            this.activeGrabs--;
                            this.emitGrabProgress();
                            emitLog(formatMemorySnapshot('pipeline site batch complete', process.memoryUsage(), {
                                site: nextSite,
                                completed: this.grabsCompleted,
                                successful: this.grabsSuccessful,
                                failed: this.grabsFailed
                            }), 'info');
                            // Hint GC after each batch to reclaim XML parse buffers
                            if (global.gc) { try { global.gc(); } catch (_) {} }
                            this.processGrabQueue();
                            this.checkPipelineComplete();
                        });
                });
            }
        } finally {
            this.isProcessingGrabQueue = false;
        }
    }

    private emitGrabProgress() {
        const noSource = this.noSourceIds.size;
        const noSourceNote = noSource > 0 ? `, ${noSource} with no source` : '';

        if (this.totalToGrab === 0) {
            if (this.isMatchingComplete) {
                const message = noSource > 0
                    ? `Complete: no grab-capable source for ${noSource} channel(s) ✓`
                    : 'Complete: No EPG grab required ✓';
                emitProgressComplete('grab', message, 0);
            }
            return;
        }

        const isFullyDone = this.isMatchingComplete && this.activeGrabs === 0 && this.grabBatches.size === 0 && this.grabsCompleted >= this.totalToGrab;
        if (isFullyDone) {
            emitProgressComplete('grab', `Complete: ${this.grabsSuccessful} ok, ${this.grabsFailed} failed${noSourceNote} ✓`, this.totalToGrab);
        } else {
            const msg = `Grabbing: ${this.grabsCompleted}/${this.totalToGrab} (${this.grabsSuccessful} ok, ${this.grabsFailed} failed${noSourceNote})`;
            emitProgress(msg, this.grabsCompleted, this.totalToGrab, 'grab');
        }
    }

    /** Counts for the caller's report. */
    public getGrabStats() {
        return {
            totalToGrab: this.totalToGrab,
            completed: this.grabsCompleted,
            successful: this.grabsSuccessful,
            failed: this.grabsFailed,
            noSource: this.noSourceIds.size,
            noSourceIds: [...this.noSourceIds]
        };
    }

    private processEnrichQueue() {
        if (this.isCancelled) return;
        if (this.totalToEnrich > 0) {
            emitProgress(`Enriching: ${this.enrichesCompleted}/${this.totalToEnrich} channels`, this.enrichesCompleted, this.totalToEnrich, 'enrich');
        }

        while (!this.isCancelled && this.activeEnriches < this.MAX_CONCURRENT_ENRICHES && this.enrichQueue.length > 0) {
            const xmltvId = this.enrichQueue.shift()!;
            this.activeEnriches++;

            enrichProgramsWithMetadata(xmltvId).then((stats) => {
                if (this.isCancelled) return;
                this.enrichesSuccessful += stats.enriched;
            }).catch((err) => {
                if (this.isCancelled) return;
                emitLog(`[Pipeline] Enrich error for ${xmltvId}: ${err.message}`, 'error');
            }).finally(() => {
                this.enrichesCompleted++;
                this.activeEnriches--;
                if (this.totalToEnrich > 0) {
                    emitProgress(`Enriching: ${this.enrichesCompleted}/${this.totalToEnrich} channels`, this.enrichesCompleted, this.totalToEnrich, 'enrich');
                }
                this.processEnrichQueue();
                this.checkPipelineComplete();
            });
        }
    }

    private checkPipelineComplete() {
        if (
            this.isMatchingComplete &&
            this.grabBatches.size === 0 &&
            this.activeGrabs === 0
        ) {
            // Once all grabs finish, check if there are any remaining existing channels needing enrichment
            if (!this.hasEnrichedExistingChannels) {
                this.hasEnrichedExistingChannels = true;
                this.enrichAllExistingChannels();
            }

            if (this.enrichQueue.length === 0 && this.activeEnriches === 0) {
                this.emitGrabProgress();
                if (this.totalToEnrich > 0) {
                    emitProgressComplete('enrich', `Complete: Enriched programs for ${this.enrichesCompleted}/${this.totalToEnrich} channels ✓`, this.totalToEnrich);
                } else {
                    emitProgressComplete('enrich', 'Complete: No pending programs to enrich ✓', 0);
                }
                emitLog(formatMemorySnapshot('pipeline complete', process.memoryUsage(), {
                    grabsCompleted: this.grabsCompleted,
                    enrichesCompleted: this.enrichesCompleted,
                    uniqueGrabIds: this.queuedGrabIds.size,
                    uniqueEnrichIds: this.queuedEnrichIds.size
                }), 'info');
                this.resolvePipeline();
            }
        }
    }

    public cancel() {
        this.isCancelled = true;
        this.grabBatches.clear();
        this.enrichQueue = [];
        
        // Terminate any active subprocess grab processes
        import('./grabber.js').then(({ cancelAllGrabProcesses }) => {
            cancelAllGrabProcesses();
        }).catch(err => console.error("Error calling cancelAllGrabProcesses:", err));

        emitLog("Sync pipeline cancelled by user request.", "warning");
        emitProgress(`Cancelled`, this.grabsCompleted, this.totalToGrab, 'grab');
        emitProgress(`Cancelled`, this.enrichesCompleted, this.totalToEnrich, 'enrich');
        this.resolvePipeline();
    }
}
