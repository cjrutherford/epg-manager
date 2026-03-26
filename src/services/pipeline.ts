import { db } from '../db';
import { emitLog, emitProgress, emitProgressComplete } from '../events';
import { grabChannel } from './grabber';
import { enrichProgramsWithMetadata } from './metadata';

export class PipelineQueue {
    private grabQueue: { xmltvId: string; sites: string[] }[] = [];
    private enrichQueue: string[] = [];

    // Concurrency tracking
    private activeGrabs = 0;
    private activeEnriches = 0;
    private activeSites = new Set<string>();
    private isProcessingGrabQueue = false;

    // Configurable limits
    private readonly MAX_CONCURRENT_GRABS = 3;
    private readonly MAX_CONCURRENT_ENRICHES = 2;

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
        if (xmltvIds.length === 0) return;

        this.totalMatched += xmltvIds.length;
        this.totalToGrab += xmltvIds.length;

        const siteMap: Record<string, string[]> = {};
        const chunkSize = 500;
        for (let i = 0; i < xmltvIds.length; i += chunkSize) {
            const chunk = xmltvIds.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            const res = await db.execute({
                sql: `SELECT xmltv_id, site FROM iptv_org_map WHERE xmltv_id IN (${placeholders})`,
                args: chunk
            });
            for (let row of res.rows) {
                const id = String(row.xmltv_id);
                if (!siteMap[id]) siteMap[id] = [];
                if (row.site) siteMap[id].push(String(row.site));
            }
        }

        for (const id of xmltvIds) {
            this.grabQueue.push({ xmltvId: id, sites: siteMap[id] || [] });
        }

        // As soon as channels drop into the queue, we kick off workers if there's idle capacity
        this.processGrabQueue();
        this.emitGrabProgress();
    }

    /**
     * Called by the Matcher when all scanning is done.
     * The pipeline won't resolve until this is called AND all queues are empty.
     */
    public setMatchingComplete(totalScanned: number, totalMatched: number) {
        this.isMatchingComplete = true;
        this.totalMatched = totalMatched;
        this.matchProgress = totalScanned;
        emitProgressComplete('match', `Complete: ${totalMatched}/${totalScanned} channels matched ✓`, totalScanned);

        // Also queue enrichment for all channels that have EPG data but weren't just grabbed
        // This ensures metadata enrichment runs for ALL matched channels, not just newly grabbed ones
        this.enrichAllExistingChannels();
        this.checkPipelineComplete();
    }

    /**
     * Queue enrichment for all channels that have EPG programs in the database.
     * This ensures previously-matched channels also get their metadata enriched.
     */
    private async enrichAllExistingChannels() {
        try {
            // Get all unique channel IDs that have EPG programs but need enrichment
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
                emitLog('[Pipeline] No existing EPG data to enrich', 'info');
                return;
            }

            emitLog(`[Pipeline] Queueing enrichment for ${channelIds.length} existing channels with EPG data...`, 'info');

            // Add all to enrichment queue
            for (const id of channelIds) {
                // Only add if not already in queue from current grab
                if (!this.enrichQueue.includes(id)) {
                    this.totalToEnrich++;
                    this.enrichQueue.push(id);
                }
            }

            this.processEnrichQueue();
        } catch (err: any) {
            console.error('[Pipeline] Error queuing existing channels for enrichment:', err.message);
        }
    }

    /**
     * Wait for everything currently running + queued to finish.
     */
    public waitForCompletion(): Promise<void> {
        // Just in case we were awaited before anything was queued and match was already complete
        this.checkPipelineComplete();
        return this.pipelinePromise;
    }

    // --- GRAB QUEUE ---

    private processGrabQueue() {
        if (this.isProcessingGrabQueue) return;
        this.isProcessingGrabQueue = true;

        try {
            while (this.activeGrabs < this.MAX_CONCURRENT_GRABS && this.grabQueue.length > 0) {
                let nextIndex = -1;
                let nextXmltvId = '';
                let nextSites: string[] = [];

                // Find a channel whose sites do not overlap with currently active grabs
                for (let i = 0; i < this.grabQueue.length; i++) {
                    const item = this.grabQueue[i];
                    const hasOverlap = item.sites.some(s => this.activeSites.has(s));
                    if (!hasOverlap) {
                        nextIndex = i;
                        nextXmltvId = item.xmltvId;
                        nextSites = item.sites;
                        break;
                    }
                }

                if (nextIndex === -1) {
                    // No channels available that avoid site overlaps
                    break;
                }

                this.grabQueue.splice(nextIndex, 1);
                this.activeGrabs++;
                nextSites.forEach(s => this.activeSites.add(s));

                emitLog(`[Pipeline] Grabbing EPG for channel: ${nextXmltvId}`, 'info');
                emitProgress(`Grabbing: [${nextXmltvId}] ${this.grabsCompleted}/${this.totalToGrab}`, this.grabsCompleted, this.totalToGrab, 'grab');

                grabChannel(nextXmltvId, this.epgDays).then((success) => {
                    if (success) {
                        this.grabsSuccessful++;
                        // If successfully grabbed EPG data, queue it for enrichment!
                        this.totalToEnrich++;
                        this.enrichQueue.push(nextXmltvId);
                        this.processEnrichQueue();
                    } else {
                        this.grabsFailed++;
                    }
                }).catch((err) => {
                    this.grabsFailed++;
                    emitLog(`[Pipeline] Grab error for ${nextXmltvId}: ${err.message}`, 'error');
                }).finally(() => {
                    this.grabsCompleted++;
                    this.activeGrabs--;
                    nextSites.forEach(s => this.activeSites.delete(s));
                    this.emitGrabProgress();
                    this.processGrabQueue(); // Pick up next in queue
                    this.checkPipelineComplete();
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

    // --- ENRICH QUEUE ---

    private processEnrichQueue() {
        while (this.activeEnriches < this.MAX_CONCURRENT_ENRICHES && this.enrichQueue.length > 0) {
            const xmltvId = this.enrichQueue.shift()!;
            this.activeEnriches++;
            emitLog(`[Pipeline] Enriching metadata for channel: ${xmltvId}`, 'info');
            emitProgress(`Enriching: [${xmltvId}] ${this.enrichesCompleted}/${this.totalToEnrich}`, this.enrichesCompleted, this.totalToEnrich, 'enrich');

            enrichProgramsWithMetadata(xmltvId).then((stats) => {
                this.enrichesSuccessful += stats.enriched;
            }).catch((err) => {
                emitLog(`[Pipeline] Enrich error for ${xmltvId}: ${err.message}`, 'error');
            }).finally(() => {
                this.enrichesCompleted++;
                this.activeEnriches--;
                this.processEnrichQueue(); // Pick up next in queue
                this.checkPipelineComplete();
            });
        }
    }

    // Removing emitEnrichProgress entirely so metadata.ts's granular logs drive the UI,
    // except for completion which is handled in checkPipelineComplete.

    // --- PIPELINE LIFECYCLE ---

    private checkPipelineComplete() {
        if (
            this.isMatchingComplete &&
            this.grabQueue.length === 0 &&
            this.activeGrabs === 0 &&
            this.enrichQueue.length === 0 &&
            this.activeEnriches === 0
        ) {
            // Pipeline truly empty, all Match -> Grab -> Enrich chains finished
            if (this.totalToEnrich > 0) {
                emitProgressComplete('enrich', `Complete: Enriched programs for ${this.enrichesCompleted} channels ✓`, this.totalToEnrich);
            }
            this.resolvePipeline();
        }
    }
}
