/**
 * bundle adapter — an archive containing many playlists or guides.
 *
 * Covers the iptv-org/iptv gh-pages archive and any curated collection
 * published as a zip. Extraction is stage-and-swap on the filesystem: the
 * archive is unpacked to a temp directory and only moved over the target once
 * it has extracted cleanly, so a failed download never destroys the previous
 * copy.
 */

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { DB_DIR } from '../../../db';
import type { AdapterContext, ChannelRow, ProbeResult, SourceAdapter } from '../adapter';
import type { SourceDescriptor } from '../descriptor';
import { parsePlaylist } from './m3u';

/** Where a bundle unpacks to, derived from its descriptor id. */
export function bundleTargetDir(descriptor: SourceDescriptor): string {
    const configured = (descriptor as any).extractTo as string | undefined;
    const name = configured || descriptor.id;
    const resolvedBase = path.resolve(DB_DIR);
    const resolved = path.resolve(resolvedBase, name);
    if (!resolved.startsWith(resolvedBase + path.sep)) {
        throw new Error(`Refusing to extract outside the data directory: ${name}`);
    }
    return resolved;
}

/** GitHub archives wrap everything in a single root directory; unwrap it. */
export function findArchiveRoot(entries: string[]): string | null {
    const tops = new Set(
        entries
            .map(entry => entry.split('/')[0])
            .filter(Boolean)
    );
    return tops.size === 1 ? [...tops][0] : null;
}

/** Playlist files inside an extracted bundle, relative to its root. */
export function listPlaylistFiles(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 4) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (/\.m3u8?$/i.test(entry.name)) found.push(full);
        }
    };
    walk(root, 0);
    return found.sort();
}

export const bundleAdapter: SourceAdapter = {
    kind: 'bundle',

    async probe(descriptor, ctx): Promise<ProbeResult> {
        const url = descriptor.fetch.url;
        if (!url) {
            return {
                ok: false, provides: [], sample: {}, counts: {}, warnings: [],
                error: { code: 'NO_URL', message: 'Bundle source has no url' }
            };
        }

        // Probing a bundle means downloading it, so report what it contains
        // without writing anything to the target directory.
        try {
            const result = await ctx.fetch(url, {
                maxBytes: descriptor.fetch.maxBytes,
                timeoutMs: descriptor.fetch.timeoutMs
            });
            if (result.notModified || !result.body) {
                return {
                    ok: true, provides: ['channels'], sample: {}, counts: {},
                    warnings: ['Source reports no change since the last fetch']
                };
            }

            const zip = new AdmZip(result.body);
            const names = zip.getEntries().map(entry => entry.entryName);
            const playlists = names.filter(name => /\.m3u8?$/i.test(name));

            return {
                ok: playlists.length > 0,
                provides: ['channels'],
                detectedKind: 'bundle',
                sample: {},
                counts: { channels: playlists.length },
                warnings: playlists.length === 0 ? ['Archive contains no playlist files'] : []
            };
        } catch (e: any) {
            return {
                ok: false, provides: [], sample: {}, counts: {}, warnings: [],
                error: { code: 'FETCH_FAILED', message: e.message }
            };
        }
    },

    /**
     * Download and unpack, then yield every channel across the contained
     * playlists. The extract is atomic: temp directory first, rename last.
     */
    async *fetchLineup(descriptor, ctx): AsyncIterable<ChannelRow> {
        const url = descriptor.fetch.url;
        if (!url) throw new Error('Bundle source has no url');

        const result = await ctx.fetch(url, {
            maxBytes: descriptor.fetch.maxBytes,
            timeoutMs: descriptor.fetch.timeoutMs
        });
        if (result.notModified || !result.body) {
            ctx.log(`${descriptor.label}: unchanged since last fetch`, 'info');
            return;
        }

        const targetDir = bundleTargetDir(descriptor);
        const stagingDir = `${targetDir}.incoming`;

        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.mkdirSync(stagingDir, { recursive: true });

        const zip = new AdmZip(result.body);
        zip.extractAllTo(stagingDir, true);

        const root = findArchiveRoot(zip.getEntries().map(entry => entry.entryName));
        const extracted = root ? path.join(stagingDir, root) : stagingDir;

        // Swap only once the archive has unpacked cleanly.
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(extracted, targetDir);
        fs.rmSync(stagingDir, { recursive: true, force: true });
        ctx.log(`${descriptor.label}: extracted to ${path.basename(targetDir)}`, 'success');

        for (const file of listPlaylistFiles(targetDir)) {
            let text: string;
            try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
            for (const row of parsePlaylist(text)) {
                yield row;
            }
        }
    }
};
