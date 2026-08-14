/**
 * Streaming M3U parser.
 *
 * `iptv-playlist-parser` takes the whole playlist as a string and returns the
 * whole result as an array, so peak memory scaled with playlist size: a 50,000
 * channel list cost ~68 MB of heap on top of the 6 MB file. This reads line by
 * line and yields channels as it goes, so a playlist of any size costs the same.
 *
 * The format is simple enough to parse directly:
 *
 *   #EXTINF:-1 tvg-id="bbc1.uk" group-title="UK",BBC One
 *   #EXTGRP:UK                     (optional, group on its own line)
 *   http://stream/bbc1
 */

import type { ChannelRow } from './adapter';

/**
 * Split an `#EXTINF` line into its attribute section and display name.
 *
 * The name follows the first comma that is not inside a quoted attribute
 * value — splitting on the first comma outright breaks on
 * `group-title="News, Sport"`, and splitting on the last breaks on names
 * that contain commas.
 */
export function splitExtinf(line: string): { attributes: string; name: string } {
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            return {
                attributes: line.slice(0, i),
                name: line.slice(i + 1).trim()
            };
        }
    }

    return { attributes: line, name: '' };
}

/** Pull `key="value"` pairs out of an `#EXTINF` attribute section. */
export function parseExtinfAttributes(attributes: string): Record<string, string> {
    const found: Record<string, string> = {};
    const pattern = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(attributes)) !== null) {
        found[match[1].toLowerCase()] = match[2];
    }

    return found;
}

interface PendingChannel {
    name: string;
    tvgId: string;
    tvgLogo: string;
    groupTitle: string;
    lang?: string;
}

function pendingFromExtinf(line: string): PendingChannel {
    const { attributes, name } = splitExtinf(line);
    const attrs = parseExtinfAttributes(attributes);

    return {
        // tvg-name is a fallback for playlists that leave the display name empty
        name: name || attrs['tvg-name'] || 'Unknown Channel',
        tvgId: attrs['tvg-id'] || '',
        tvgLogo: attrs['tvg-logo'] || '',
        groupTitle: attrs['group-title'] || '',
        lang: attrs['tvg-language'] || undefined
    };
}

/**
 * Parse a stream of lines into channels.
 *
 * Yields as soon as each channel's url arrives, so nothing accumulates. Entries
 * without a url are dropped, matching the previous behaviour.
 */
export async function* parseM3ULines(lines: AsyncIterable<string>): AsyncIterable<ChannelRow> {
    let pending: PendingChannel | null = null;

    for await (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            pending = pendingFromExtinf(line.slice('#EXTINF:'.length));
            continue;
        }

        if (line.startsWith('#EXTGRP:')) {
            // Group carried on its own line; only fills a gap, never overrides
            if (pending && !pending.groupTitle) {
                pending.groupTitle = line.slice('#EXTGRP:'.length).trim();
            }
            continue;
        }

        // Any other directive (#EXTM3U, #EXTVLCOPT, comments) is not a stream url
        if (line.startsWith('#')) continue;

        if (pending) {
            yield {
                name: pending.name,
                url: line,
                tvgId: pending.tvgId,
                tvgLogo: pending.tvgLogo,
                groupTitle: pending.groupTitle,
                lang: pending.lang
            };
            pending = null;
        }
        // A url with no preceding #EXTINF is skipped: there is no channel to
        // attach it to, and inventing one would produce a nameless entry.
    }
}

/** Split a byte/string stream into lines without buffering the whole input. */
export async function* iterateLines(chunks: AsyncIterable<Buffer | string>): AsyncIterable<string> {
    let carry = '';

    for await (const chunk of chunks) {
        carry += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

        let newlineIndex: number;
        while ((newlineIndex = carry.indexOf('\n')) !== -1) {
            yield carry.slice(0, newlineIndex).replace(/\r$/, '');
            carry = carry.slice(newlineIndex + 1);
        }
    }

    if (carry.length > 0) {
        yield carry.replace(/\r$/, '');
    }
}

/** Convenience for callers that already hold the whole playlist as text. */
export async function* parseM3UText(text: string): AsyncIterable<ChannelRow> {
    async function* lines() {
        for (const line of text.split('\n')) {
            yield line.replace(/\r$/, '');
        }
    }
    yield* parseM3ULines(lines());
}
