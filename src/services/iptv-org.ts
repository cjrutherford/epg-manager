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

        // Delete iptv_org_map in chunks to avoid long-running exclusive lock
        const countResult = await db.execute("SELECT COUNT(*) as c FROM iptv_org_map");
        const totalRows = Number(countResult.rows[0]?.c || 0);
        if (totalRows > 0) {
            emitLog(`Clearing existing iptv_org_map (${totalRows} rows)...`, 'info');
            const CHUNK = 200;
            for (let i = 0; i < totalRows; i += CHUNK) {
                await db.execute({
                    sql: `DELETE FROM iptv_org_map WHERE rowid IN (SELECT rowid FROM iptv_org_map LIMIT ?)`,
                    args: [CHUNK]
                });
            }
        }
        await db.execute({ sql: `DELETE FROM epg_source_channels WHERE provider = ?`, args: ['iptv-org'] });

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
                            batch = [];
                        }
                    });
                } catch (e: any) {
                    emitLog(`[DEBUG] Error parsing file ${file} in ${site}: ${e.message}`, "error", true);
                }
            }
        }

        if (batch.length > 0) {
            await insertBatch(batch);
        }

        await refreshIptvOrgSourceImportCounts();

        progressBar.stop();
        emitLog(formatMemorySnapshot('iptv-org update complete', process.memoryUsage(), { mapped: mappedCount, sites: sites.length }), 'info');
        emitLog(`IPTV-ORG Data Updated. Mapped ${mappedCount} channels with site metadata.`, "success");
        emitProgressComplete('metadata', `Metadata updated: ${mappedCount} channels mapped`, sites.length);

    } catch (e: any) {
        emitLog(`Failed to update IPTV-ORG data: ${e.message}`, "error");
        emitProgress(`Metadata update failed: ${e.message}`, 0, 1, 'metadata');
    }
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
            sql: `INSERT INTO epg_sources (
                    key, provider, site, label, enabled, priority, grab_capable,
                    channel_count_estimate, imported_rows, last_sync_at, last_sync_status, last_error, notes
                  )
                  VALUES (?, ?, ?, ?, 1, ?, 1, ?, 0, ?, 'syncing', NULL, ?)
                  ON CONFLICT(key) DO UPDATE SET
                    provider = excluded.provider,
                    site = excluded.site,
                    label = excluded.label,
                    priority = excluded.priority,
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

async function refreshIptvOrgSourceImportCounts() {
    await db.execute({
        sql: `UPDATE epg_sources
              SET imported_rows = (
                    SELECT COUNT(*) FROM epg_source_channels esc WHERE esc.source_key = epg_sources.key
                  ),
                  last_sync_status = 'success',
                  last_error = NULL,
                  last_sync_at = ?
              WHERE provider = ?`,
        args: [Date.now(), 'iptv-org']
    });
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
