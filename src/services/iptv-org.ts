import { db, DB_DIR } from '../db';
import { emitLog, emitProgress, emitProgressComplete } from '../events';
import cliProgress from 'cli-progress';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { formatMemorySnapshot } from './memory';
import { IptvOrgChannelRow, parseIptvOrgChannelsXmlStream } from './iptv-org-parser';
import { buildEpgSourceKey, getFeaturedIptvOrgSource, parseIptvOrgSitesMarkdown } from './epg-sources';
import type { CatalogRow } from './sources/adapter';
import { clearAllStaging, commitStaging, discardStaging, stageRows } from './sources/staging';

const REPO_URL = 'https://github.com/iptv-org/epg.git';
const DATA_DIR = path.join(DB_DIR, 'iptv-org-epg');

async function downloadAndExtractZip(url: string, targetDir: string): Promise<void> {
    const zipPath = path.join(DB_DIR, 'temp-download.zip');
    const extractDir = path.join(DB_DIR, 'temp-extract');

    try {
        // Download with streaming
        const response = await axios.get(url, { responseType: 'stream', timeout: 120000 });
        const totalLength = parseInt(String(response.headers['content-length'] || '0'), 10);
        let received = 0;

        const writer = fs.createWriteStream(zipPath);
        response.data.pipe(writer);

        let lastLogTime = 0;
        response.data.on('data', (chunk: Buffer) => {
            received += chunk.length;
            const now = Date.now();
            if (totalLength > 0 && now - lastLogTime > 2000) {
                lastLogTime = now;
                const pct = Math.round((received / totalLength) * 100);
                emitLog(`Downloading... ${pct}% (${(received / 1024 / 1024).toFixed(1)}MB)`, 'info');
            }
        });

        await new Promise<void>((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Clean target and extract
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);

        // Find the single root directory inside the zip (GitHub convention)
        const items = fs.readdirSync(extractDir);
        const rootDir = items.find(item => {
            try { return fs.statSync(path.join(extractDir, item)).isDirectory(); }
            catch { return false; }
        });
        if (!rootDir) throw new Error('No root directory found in extracted archive');

        const extractedPath = path.join(extractDir, rootDir);

        // Atomically replace target
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(extractedPath, targetDir);

        emitLog(`Extracted to ${targetDir}`, 'success');
    } finally {
        // Cleanup temp files
        try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

export async function updateIptvOrgData() {
    try {
        emitLog("Updating IPTV-ORG Channel Map from source repo...", "info");
        emitLog(formatMemorySnapshot('iptv-org update start'), 'info');

        emitLog("Downloading latest IPTV-ORG EPG zip archive...", "info");
        await downloadAndExtractZip(
            'https://github.com/iptv-org/epg/archive/refs/heads/master.zip',
            DATA_DIR
        );

        // The live catalogue is deliberately NOT cleared here. It used to be
        // deleted before the replacement was parsed, so a failed or partial
        // parse left the corpus truncated and matching ran against the remains
        // (R4). Rows now go to staging and are swapped in only on success.
        await clearAllStaging();

        if (!fs.existsSync(path.join(DATA_DIR, 'node_modules'))) {
            emitLog("Scraper dependencies missing. Installing...", "info", true);
            await runCommand('npm', ['install', '--ignore-scripts'], DATA_DIR);
        }

        const sitesDir = path.join(DATA_DIR, 'sites');
        if (!fs.existsSync(sitesDir)) {
            throw new Error("Sites directory not found in repo");
        }

        const sites = fs.readdirSync(sitesDir);
        await upsertIptvOrgSources(sites);
        emitLog(`Found ${sites.length} site folders. Parsing channels...`, "info");

        const progressBar = new cliProgress.SingleBar({
            format: 'Parsing Metadata | {bar} | {percentage}% | {value}/{total} | {msg}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true
        }, cliProgress.Presets.shades_classic);

        progressBar.start(sites.length, 0, { msg: 'Initializing...' });

        const siteErrors = new Map<string, string>();
        let batch: IptvOrgChannelRow[] = [];
        const BATCH_SIZE = 100;
        let mappedCount = 0;
        let sitesProcessed = 0;

        for (const site of sites) {
            sitesProcessed++;
            if (sitesProcessed % 10 === 0 || sitesProcessed === sites.length) {
                progressBar.update(sitesProcessed, { msg: site });
                emitProgress(`Parsing metadata... (${mappedCount} channels)`, sitesProcessed, sites.length, 'metadata');
            }
            const sitePath = path.join(sitesDir, site);
            if (!fs.statSync(sitePath).isDirectory()) continue;

            const files = fs.readdirSync(sitePath).filter(f => f.endsWith('.channels.xml'));

            for (const file of files) {
                try {
                    const filePath = path.join(sitePath, file);
                    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
                    await parseIptvOrgChannelsXmlStream(input, async (row) => {
                        batch.push(row);
                        mappedCount++;

                        if (batch.length >= BATCH_SIZE) {
                            await insertBatch(batch);
                            await stageBatch(batch);
                            batch = [];
                        }
                    });
                } catch (e: any) {
                    emitLog(`Error parsing ${file} in ${site}: ${e.message}`, "error", true);
                    siteErrors.set(site, e.message);
                }
            }
        }

        if (batch.length > 0) {
            await insertBatch(batch);
            await stageBatch(batch);
        }

        // Parse succeeded — swap each source's staged catalogue into place. A
        // source whose parse failed keeps whatever it had before.
        const swapSummary = await commitStagedCatalogs(sites, siteErrors);
        emitLog(
            `Catalogue swap: ${swapSummary.swapped} source(s) updated, ` +
            `${swapSummary.kept} kept previous data, ${swapSummary.failed} failed.`,
            'info'
        );

        await refreshIptvOrgSourceImportCounts(siteErrors);

        progressBar.stop();
        emitLog(formatMemorySnapshot('iptv-org update complete', process.memoryUsage(), { mapped: mappedCount, sites: sites.length }), 'info');
        emitLog(`IPTV-ORG Data Updated. Mapped ${mappedCount} channels with site metadata.`, "success");
        emitProgressComplete('metadata', `Metadata updated: ${mappedCount} channels mapped`, sites.length);

    } catch (e: any) {
        emitLog(`Failed to update IPTV-ORG data: ${e.message}`, "error");
        emitProgress(`Metadata update failed: ${e.message}`, 0, 1, 'metadata');
    }
}

/**
 * Swap staged catalogues in, one source at a time. A source that parsed to
 * nothing keeps its previous rows rather than being emptied — the failure mode
 * this whole path exists to prevent.
 */
async function commitStagedCatalogs(sites: string[], siteErrors: Map<string, string>) {
    let swapped = 0;
    let kept = 0;
    let failed = 0;

    for (const site of sites) {
        const sourceKey = buildEpgSourceKey('iptv-org', site);

        if (siteErrors.has(site)) {
            await discardStaging(sourceKey);
            failed++;
            continue;
        }

        try {
            const result = await commitStaging(sourceKey);
            if (result.swapped) {
                swapped++;
            } else {
                kept++;
                if (result.reason) {
                    emitLog(`[${site}] ${result.reason}`, 'warning');
                }
            }
        } catch (e: any) {
            emitLog(`[${site}] Catalogue swap failed: ${e.message}`, 'error');
            await discardStaging(sourceKey).catch(() => { /* best effort */ });
            failed++;
        }
    }

    return { swapped, kept, failed };
}

async function upsertIptvOrgSources(sites: string[]) {
    const sitesMdPath = path.join(DATA_DIR, 'SITES.md');
    const summaries = fs.existsSync(sitesMdPath)
        ? parseIptvOrgSitesMarkdown(fs.readFileSync(sitesMdPath, 'utf8'))
        : [];
    const summaryBySite = new Map(summaries.map(source => [source.site, source]));
    const now = Date.now();

    for (const site of sites) {
        const summary = summaryBySite.get(site);
        const featured = getFeaturedIptvOrgSource(site);
        await db.execute({
            sql: `INSERT INTO sources (
                    key, provider, site, label, enabled, priority, grab_capable,
                    channel_count_estimate, imported_rows, last_sync_at, last_sync_status, last_error, notes
                  )
                  VALUES (?, ?, ?, ?, 1, ?, 1, ?, 0, ?, 'syncing', NULL, ?)
                  ON CONFLICT(key) DO UPDATE SET
                    provider = excluded.provider,
                    site = excluded.site,
                    label = excluded.label,
                    -- priority and enabled are the user's to set; a catalogue
                    -- refresh must not silently reset their choices (R6).
                    grab_capable = 1,
                    channel_count_estimate = excluded.channel_count_estimate,
                    imported_rows = 0,
                    last_sync_at = excluded.last_sync_at,
                    last_sync_status = 'syncing',
                    last_error = NULL,
                    notes = excluded.notes`,
            args: [
                buildEpgSourceKey('iptv-org', site),
                'iptv-org',
                site,
                featured?.label || summary?.label || site,
                featured?.priority || 0,
                summary?.channelCountEstimate ?? null,
                now,
                [featured?.notes, summary?.notes].filter(Boolean).join(' | ') || null
            ]
        });
    }
}

/**
 * Record the outcome of a catalogue refresh, per source.
 *
 * This previously set every iptv-org row to 'success' with a null error in one
 * blanket UPDATE, whatever had actually happened — so a site whose catalogue
 * failed to parse still reported success with zero rows, and the Diagnostics
 * status column could never show a failure. Status is now derived from what
 * each source actually imported, and per-site parse errors are attributed.
 */
async function refreshIptvOrgSourceImportCounts(siteErrors: Map<string, string> = new Map()) {
    const now = Date.now();

    await db.execute({
        sql: `UPDATE sources
              SET imported_rows = (
                    SELECT COUNT(*) FROM epg_source_channels esc WHERE esc.source_key = sources.key
                  ),
                  last_sync_at = ?
              WHERE provider = ?`,
        args: [now, 'iptv-org']
    });

    // A source that imported nothing did not succeed, whatever the run did overall.
    await db.execute({
        sql: `UPDATE sources
              SET last_sync_status = CASE WHEN imported_rows > 0 THEN 'success' ELSE 'empty' END,
                  last_error = CASE WHEN imported_rows > 0 THEN NULL
                                    ELSE 'Source refresh imported no channels' END
              WHERE provider = ?`,
        args: ['iptv-org']
    });

    for (const [site, message] of siteErrors.entries()) {
        await db.execute({
            sql: `UPDATE sources
                  SET last_sync_status = 'failed', last_error = ?
                  WHERE key = ?`,
            args: [message.slice(0, 500), buildEpgSourceKey('iptv-org', site)]
        });
    }
}

/** Stage a batch of parsed catalogue rows, grouped by the source that owns them. */
async function stageBatch(batch: IptvOrgChannelRow[]) {
    const bySource = new Map<string, CatalogRow[]>();
    for (const row of batch) {
        if (!row.site || !row.site_id) continue;
        const key = buildEpgSourceKey('iptv-org', String(row.site));
        if (!bySource.has(key)) bySource.set(key, []);
        bySource.get(key)!.push({
            name: row.name,
            xmltvId: row.xmltv_id,
            site: String(row.site),
            siteId: String(row.site_id),
            lang: row.lang || 'en'
        });
    }
    for (const [sourceKey, rows] of bySource.entries()) {
        await stageRows(sourceKey, 'iptv-org', rows);
    }
}

async function insertBatch(batch: IptvOrgChannelRow[]) {
    try {
        const mapRows = batch.map(row => [row.name, row.xmltv_id, row.lang, row.site, row.site_id]);
        const sourceRows = batch
            .filter(row => row.site && row.site_id)
            .map(row => [
                buildEpgSourceKey('iptv-org', String(row.site)),
                'iptv-org',
                row.name,
                row.xmltv_id,
                row.lang,
                row.site,
                row.site_id
            ]);
        const mapPlaceholders = mapRows.map(() => "(?, ?, ?, ?, ?)").join(",");
        await db.execute({
            sql: `INSERT OR REPLACE INTO iptv_org_map (name, xmltv_id, lang, site, site_id) VALUES ${mapPlaceholders}`,
            args: mapRows.flat()
        });
        if (sourceRows.length > 0) {
            const sourcePlaceholders = sourceRows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
            await db.execute({
                sql: `INSERT OR REPLACE INTO epg_source_channels (source_key, provider, name, xmltv_id, lang, site, site_id) VALUES ${sourcePlaceholders}`,
                args: sourceRows.flat()
            });
        }
    } catch (e: any) {
        emitLog(`Insert batch failed: ${e.message}`, "error");
        throw e;
    }
}

function runCommand(cmd: string, args: string[], cwd?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Command ${cmd} ${args.join(' ')} failed with code ${code}`));
        });
        proc.on('error', (err) => reject(err));
    });
}
