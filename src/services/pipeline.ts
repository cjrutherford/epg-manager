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
        this.totalToGrab += uniqueIds.length;
        emitLog(formatMemorySnapshot('pipeline enqueue matched', process.memoryUsage(), {
            queued: uniqueIds.length,
            totalQueued: this.totalToGrab,
            uniqueQueuedIds: this.queuedGrabIds.size
        }), 'info');

        const chunkSize = 500;
        for (let i = 0; i < uniqueIds.length; i += chunkSize) {
            const chunk = uniqueIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            // Get the primary site for each channel
            const res = await db.execute({
                sql: `
                    SELECT xmltv_id, site, site_id, lang 
                    FROM iptv_org_map 
                    WHERE xmltv_id IN (${placeholders}) 
                    AND site IS NOT NULL 
                    GROUP BY xmltv_id
                    ORDER BY site
                `,
                args: chunk
            });
            
            for (let row of res.rows) {
                const site = String(row.site);
                if (!this.grabBatches.has(site)) {
                    this.grabBatches.set(site, []);
                }
                this.grabBatches.get(site)!.push({
                    xmltvId: String(row.xmltv_id),
                    site_id: String(row.site_id),
                    lang: String(row.lang || 'en')
                });
            }
        }

        this.processGrabQueue();
        this.emitGrabProgress();
    }

    public setMatchingComplete(totalScanned: number, totalMatched: number) {
        this.isMatchingComplete = true;
        this.totalMatched = totalMatched;
        this.matchProgress = totalScanned;
        emitProgressComplete('match', `Complete: ${totalMatched}/${totalScanned} channels matched ✓`, totalScanned);

        this.enrichAllExistingChannels();
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
        if (this.totalToGrab === 0) return;

        if (this.grabsCompleted >= this.totalToGrab && this.isMatchingComplete) {
            emitProgressComplete('grab', `Complete: ${this.grabsSuccessful} ok, ${this.grabsFailed} failed ✓`, this.totalToGrab);
        } else {
            const msg = `Grabbing: ${this.grabsCompleted}/${this.totalToGrab} (${this.grabsSuccessful} ok, ${this.grabsFailed} failed)`;
            emitProgress(msg, this.grabsCompleted, this.totalToGrab, 'grab');
        }
    }

    private processEnrichQueue() {
        if (this.isCancelled) return;
        while (!this.isCancelled && this.activeEnriches < this.MAX_CONCURRENT_ENRICHES && this.enrichQueue.length > 0) {
            const xmltvId = this.enrichQueue.shift()!;
            this.activeEnriches++;
            
            // Only emit every 10th item or if it's the last few to avoid UI flooding
            if (this.enrichesCompleted % 10 === 0) {
                emitProgress(`Enriching: [${xmltvId}] ${this.enrichesCompleted}/${this.totalToEnrich}`, this.enrichesCompleted, this.totalToEnrich, 'enrich');
            }

            enrichProgramsWithMetadata(xmltvId).then((stats) => {
                if (this.isCancelled) return;
                this.enrichesSuccessful += stats.enriched;
            }).catch((err) => {
                if (this.isCancelled) return;
                emitLog(`[Pipeline] Enrich error for ${xmltvId}: ${err.message}`, 'error');
            }).finally(() => {
                this.enrichesCompleted++;
                this.activeEnriches--;
                this.processEnrichQueue();
                this.checkPipelineComplete();
            });
        }
    }

    private checkPipelineComplete() {
        if (
            this.isMatchingComplete &&
            this.grabBatches.size === 0 &&
            this.activeGrabs === 0 &&
            this.enrichQueue.length === 0 &&
            this.activeEnriches === 0
        ) {
            if (this.totalToEnrich > 0) {
                emitProgressComplete('enrich', `Complete: Enriched programs for ${this.enrichesCompleted} channels ✓`, this.totalToEnrich);
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

    public cancel() {
        this.isCancelled = true;
        this.grabBatches.clear();
        this.enrichQueue = [];
        
        // Terminate any active subprocess grab processes
        import('./grabber.js').then(({ cancelAllGrabProcesses }) => {
            cancelAllGrabProcesses();
        }).catch(err => console.error("Error calling cancelAllGrabProcesses:", err));

        emitLog("Sync pipeline cancelled by user request.", "warning");
        emitProgressComplete('grab', `Cancelled`, this.totalToGrab);
        emitProgressComplete('enrich', `Cancelled`, this.totalToEnrich);
        this.resolvePipeline();
    }
}
