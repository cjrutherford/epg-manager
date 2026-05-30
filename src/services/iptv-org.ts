import { db, DB_DIR } from '../db';
import { emitLog, emitProgress } from '../events';
import cliProgress from 'cli-progress';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { formatMemorySnapshot } from './memory';
import { parseIptvOrgChannelsXmlStream } from './iptv-org-parser';

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

        if (!fs.existsSync(path.join(DATA_DIR, 'node_modules'))) {
            emitLog("Scraper dependencies missing. Installing...", "info", true);
            await runCommand('npm', ['install', '--ignore-scripts'], DATA_DIR);
        }

        const sitesDir = path.join(DATA_DIR, 'sites');
        if (!fs.existsSync(sitesDir)) {
            throw new Error("Sites directory not found in repo");
        }

        const sites = fs.readdirSync(sitesDir);
        emitLog(`Found ${sites.length} site folders. Parsing channels...`, "info");

        const progressBar = new cliProgress.SingleBar({
            format: 'Parsing Metadata | {bar} | {percentage}% | {value}/{total} | {msg}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true
        }, cliProgress.Presets.shades_classic);

        progressBar.start(sites.length, 0, { msg: 'Initializing...' });

        let batch: any[] = [];
        const BATCH_SIZE = 100;
        let mappedCount = 0;
        let sitesProcessed = 0;

        for (const site of sites) {
            sitesProcessed++;
            if (sitesProcessed % 10 === 0 || sitesProcessed === sites.length) {
                progressBar.update(sitesProcessed, { msg: site });
                emitProgress(`Parsing metadata... (${mappedCount} channels)`, sitesProcessed, sites.length, 'match');
            }
            const sitePath = path.join(sitesDir, site);
            if (!fs.statSync(sitePath).isDirectory()) continue;

            const files = fs.readdirSync(sitePath).filter(f => f.endsWith('.channels.xml'));

            for (const file of files) {
                try {
                    const filePath = path.join(sitePath, file);
                    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
                    await parseIptvOrgChannelsXmlStream(input, async (row) => {
                        batch.push(row.name, row.xmltv_id, row.lang, row.site, row.site_id);
                        mappedCount++;

                        if (batch.length >= BATCH_SIZE * 5) {
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

        progressBar.stop();
        emitLog(formatMemorySnapshot('iptv-org update complete', process.memoryUsage(), { mapped: mappedCount, sites: sites.length }), 'info');
        emitLog(`IPTV-ORG Data Updated. Mapped ${mappedCount} channels with site metadata.`, "success");

    } catch (e: any) {
        emitLog(`Failed to update IPTV-ORG data: ${e.message}`, "error");
    }
}

async function insertBatch(batch: any[]) {
    try {
        const rowCount = batch.length / 5;
        const placeholders = Array(rowCount).fill("(?, ?, ?, ?, ?)").join(",");
        await db.execute({
            sql: `INSERT OR REPLACE INTO iptv_org_map (name, xmltv_id, lang, site, site_id) VALUES ${placeholders}`,
            args: batch
        });
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
