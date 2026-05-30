import * as fs from 'fs';
import * as path from 'path';
import { DB_DIR } from '../db';
import { emitLog } from '../events';
import axios from 'axios';
import AdmZip from 'adm-zip';

async function downloadAndExtractZip(url: string, targetDir: string): Promise<void> {
    const zipPath = path.join(DB_DIR, 'temp-playlists.zip');
    const extractDir = path.join(DB_DIR, 'temp-playlists-extract');

    try {
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
                emitLog(`Downloading playlists... ${pct}% (${(received / 1024 / 1024).toFixed(1)}MB)`, 'info');
            }
        });

        await new Promise<void>((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);

        const items = fs.readdirSync(extractDir);
        const rootDir = items.find(item => {
            try { return fs.statSync(path.join(extractDir, item)).isDirectory(); }
            catch { return false; }
        });
        if (!rootDir) throw new Error('No root directory found in extracted archive');

        const extractedPath = path.join(extractDir, rootDir);

        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(extractedPath, targetDir);

        emitLog(`Playlists extracted to ${targetDir}`, 'success');
    } finally {
        try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/**
 * Downloads the compiled iptv-org/iptv playlists from the gh-pages branch zip archive.
 * Extracts them natively to the local DB_DIR for zero-404 browsing and local fetching.
 */
export async function updateIptvOrgPlaylists(): Promise<void> {
    const targetDir = path.join(DB_DIR, 'iptv-org-playlists');

    emitLog('Downloading latest IPTV-ORG playlists archive...', 'info');

    await downloadAndExtractZip(
        'https://github.com/iptv-org/iptv/archive/refs/heads/gh-pages.zip',
        targetDir
    );

    emitLog('IPTV-ORG playlists archive downloaded and extracted successfully.', 'success');
}
