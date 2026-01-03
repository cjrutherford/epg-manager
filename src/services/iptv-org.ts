import { db, DB_DIR } from '../db';
import { emitLog, emitProgress } from '../events';
import cliProgress from 'cli-progress';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { XMLParser } from 'fast-xml-parser';

const REPO_URL = 'https://github.com/iptv-org/epg.git';
const DATA_DIR = path.join(DB_DIR, 'iptv-org-epg');

export async function updateIptvOrgData() {
    try {
        emitLog("Updating IPTV-ORG Channel Map from source repo...", "info");
        if (!fs.existsSync(DATA_DIR)) {
            emitLog(`Cloning ${REPO_URL}...`, "info", true);
            await runCommand('git', ['clone', '--depth', '1', REPO_URL, DATA_DIR]);
            emitLog("Installing scraper dependencies...", "info", true);
            await runCommand('npm', ['install'], DATA_DIR);
        } else {
            if (fs.existsSync(path.join(DATA_DIR, '.git'))) {
                 try {
                    await runCommand('git', ['pull'], DATA_DIR);
                    // Optionally run install if package.json changed, but for simplicity:
                    // emitLog("Updating scraper dependencies...");
                    // await runCommand('npm', ['install'], DATA_DIR);
                 } catch (e) {
                     emitLog("Git pull failed, re-cloning...", "warning", true);
                     fs.rmSync(DATA_DIR, { recursive: true, force: true });
                     await runCommand('git', ['clone', '--depth', '1', REPO_URL, DATA_DIR]);
                     emitLog("Installing scraper dependencies...", "info", true);
                     await runCommand('npm', ['install'], DATA_DIR);
                 }
            } else {
                 emitLog("Directory exists but not a git repo. Re-cloning...", "warning", true);
                 fs.rmSync(DATA_DIR, { recursive: true, force: true });
                 await runCommand('git', ['clone', '--depth', '1', REPO_URL, DATA_DIR]);
                 emitLog("Installing scraper dependencies...", "info", true);
                 await runCommand('npm', ['install'], DATA_DIR);
            }
        }

        await db.execute({ sql: "DELETE FROM iptv_org_map", args: [] });

        if (!fs.existsSync(path.join(DATA_DIR, 'node_modules'))) {
            emitLog("Scraper dependencies missing. Installing...", "info", true);
            await runCommand('npm', ['install'], DATA_DIR);
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

        const xmlParser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "" 
        });

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
                    const content = fs.readFileSync(path.join(sitePath, file), 'utf-8');
                    const parsed = xmlParser.parse(content);
                    
                    let channels = parsed.channels?.channel;
                    if (!channels) continue;
                    if (!Array.isArray(channels)) channels = [channels];

                    for (const ch of channels) {
                        const name = ch['#text'];
                        const xmltv_id = ch.xmltv_id;
                        const lang = ch.lang || null;
                        const site_val = ch.site;
                        const site_id_val = ch.site_id;

                        if (name && xmltv_id) {
                            batch.push(name);
                            batch.push(xmltv_id);
                            batch.push(lang);
                            batch.push(site_val);
                            batch.push(site_id_val);
                            mappedCount++;
                        }
                    }
                } catch (e: any) {
                    emitLog(`[DEBUG] Error parsing file ${file} in ${site}: ${e.message}`, "error", true);
                }

                if (batch.length >= BATCH_SIZE * 5) {
                    await insertBatch(batch);
                    batch = [];
                }
            }
        }

        if (batch.length > 0) {
            await insertBatch(batch);
        }

        progressBar.stop();
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
