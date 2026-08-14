/**
 * m3u adapter — playlists over HTTP or from the local data directory.
 *
 * Covers every FAST provider, every custom playlist URL, and the extracted
 * iptv-org playlist files. Fetching goes through the shared client so this
 * inherits conditional requests, byte caps, timeouts and backoff.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'iptv-playlist-parser';
import { DB_DIR } from '../../../db';
import type { AdapterContext, ChannelRow, ProbeResult, SourceAdapter } from '../adapter';
import { iterateLines, parseM3ULines } from '../m3u-stream';
import type { SourceDescriptor } from '../descriptor';

/** Local `/files/...` urls are read off disk; anything else is fetched. */
export function isLocalFilesUrl(url: string): boolean {
    return url.startsWith('/files/');
}

export function resolveLocalFilesPath(url: string): string {
    // Strip the mount prefix and re-root inside DB_DIR, never above it.
    const relative = url.replace(/^\/files\//, '');
    const resolvedBase = path.resolve(DB_DIR);
    const resolved = path.resolve(resolvedBase, relative);
    if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
        throw new Error(`Refusing to read outside the data directory: ${url}`);
    }
    return resolved;
}

/** Map a parsed playlist item onto the common channel shape. */
export function toChannelRow(item: any): ChannelRow {
    return {
        name: item?.name || 'Unknown Channel',
        url: item?.url || '',
        tvgId: item?.tvg?.id || '',
        tvgLogo: item?.tvg?.logo || '',
        groupTitle: item?.group?.title || '',
        lang: item?.tvg?.language || undefined
    };
}

/** Parse playlist text into normalized rows, dropping entries with no stream. */
export function parsePlaylist(text: string): ChannelRow[] {
    const parsed = parse(text);
    return (parsed.items || [])
        .map(toChannelRow)
        .filter(row => !!row.url);
}

async function readPlaylistText(
    descriptor: SourceDescriptor,
    ctx: AdapterContext
): Promise<{ text: string; notModified: boolean; bytes: number }> {
    const url = descriptor.fetch.url || '';
    if (!url) throw new Error('Playlist source has no url');

    if (isLocalFilesUrl(url)) {
        const localPath = resolveLocalFilesPath(url);
        const text = fs.readFileSync(localPath, 'utf8');
        return { text, notModified: false, bytes: Buffer.byteLength(text) };
    }

    const result = await ctx.fetch(url, {
        maxBytes: descriptor.fetch.maxBytes,
        timeoutMs: descriptor.fetch.timeoutMs,
        gzip: descriptor.fetch.compression === 'gzip'
    });

    if (result.notModified) {
        return { text: '', notModified: true, bytes: 0 };
    }
    return { text: result.body ? result.body.toString('utf8') : '', notModified: false, bytes: result.bytes };
}

export const m3uAdapter: SourceAdapter = {
    kind: 'm3u',

    async probe(descriptor, ctx): Promise<ProbeResult> {
        try {
            const { text, notModified } = await readPlaylistText(descriptor, ctx);
            if (notModified) {
                return {
                    ok: true, provides: ['channels'], sample: {}, counts: {},
                    warnings: ['Source reports no change since the last fetch']
                };
            }

            const rows = parsePlaylist(text);
            const warnings: string[] = [];
            if (rows.length === 0) warnings.push('No channels found in this playlist');
            const withoutIds = rows.filter(row => !row.tvgId).length;
            if (rows.length > 0 && withoutIds === rows.length) {
                warnings.push('No channel carries a tvg-id — guide matching will rely on names alone');
            } else if (withoutIds > 0) {
                warnings.push(`${withoutIds} of ${rows.length} channels have no tvg-id`);
            }
            if (rows.length > 0 && rows.every(row => !row.tvgLogo)) {
                warnings.push('No channel logos in this playlist');
            }

            return {
                ok: rows.length > 0,
                provides: ['channels'],
                detectedKind: 'm3u',
                sample: { channels: rows.slice(0, 5) },
                counts: { channels: rows.length },
                warnings
            };
        } catch (e: any) {
            return {
                ok: false, provides: [], sample: {}, counts: {},
                warnings: [],
                error: { code: 'FETCH_FAILED', message: e.message }
            };
        }
    },

    /**
     * Stream the playlist and yield channels as they parse.
     *
     * Nothing accumulates — not the body, not the parsed array — so peak memory
     * is the same for 250 channels as for 50,000.
     */
    async *fetchLineup(descriptor, ctx): AsyncIterable<ChannelRow> {
        const url = descriptor.fetch.url || '';
        if (!url) throw new Error('Playlist source has no url');

        if (isLocalFilesUrl(url)) {
            const localPath = resolveLocalFilesPath(url);
            const handle = fs.createReadStream(localPath, { encoding: 'utf8' });
            yield* parseM3ULines(iterateLines(handle as unknown as AsyncIterable<string>));
            return;
        }

        const result = await ctx.fetchStream(url, {
            maxBytes: descriptor.fetch.maxBytes,
            timeoutMs: descriptor.fetch.timeoutMs,
            gzip: descriptor.fetch.compression === 'gzip'
        });

        if (result.notModified || !result.stream) {
            ctx.log(`${descriptor.label}: unchanged since last fetch`, 'info');
            return;
        }

        yield* parseM3ULines(iterateLines(result.stream as AsyncIterable<Buffer>));
    }
};
