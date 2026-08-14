/**
 * xmltv adapter — direct guide feeds, plain or gzipped.
 *
 * This is the path that never existed. `processEpg()` — 330 lines of streaming
 * XMLTV ingest — was imported by the server and invoked nowhere (R1), and the
 * ten EPGShare feeds were declared in `epg-sources.ts` behind an accessor with
 * no callers (R2). Guide data therefore arrived only via the iptv-org site
 * scrapers, so any source publishing plain XMLTV contributed nothing no matter
 * how it was configured.
 *
 * Programmes are attributed to the source that supplied them, so guide data
 * from a direct feed merges with scraped data and can be removed again without
 * touching anyone else's.
 */

import * as sax from 'sax';
import { Readable } from 'stream';
import { db } from '../../../db';
import type {
    AdapterContext, CatalogResult, CatalogRow, ChannelRef,
    ProbeResult, ProgrammeRow, SourceAdapter, Window
} from '../adapter';
import type { SourceDescriptor } from '../descriptor';

export interface XmltvChannel {
    id: string;
    displayName: string;
    icon: string;
}

export interface XmltvParseResult {
    channels: XmltvChannel[];
    programmes: ProgrammeRow[];
    truncated: boolean;
}

/**
 * Stream XMLTV into channels and programmes.
 *
 * `limit` caps how many programmes are retained — probe only needs a sample,
 * and holding a whole national guide in memory to answer "is this usable?"
 * would be the wrong trade.
 */
export function parseXmltv(input: Readable, options: { limit?: number } = {}): Promise<XmltvParseResult> {
    return new Promise((resolve, reject) => {
        const parser = sax.parser(true, { trim: true, normalize: true });
        const channels: XmltvChannel[] = [];
        const programmes: ProgrammeRow[] = [];
        const limit = options.limit ?? Infinity;

        let currentChannel: XmltvChannel | null = null;
        let currentProgramme: ProgrammeRow | null = null;
        let textTarget: string | null = null;
        let truncated = false;

        parser.onopentag = (node: any) => {
            const name = String(node.name).toLowerCase();
            const attr = node.attributes || {};

            if (name === 'channel') {
                currentChannel = { id: String(attr.id || ''), displayName: '', icon: '' };
            } else if (name === 'programme') {
                currentProgramme = {
                    channelId: String(attr.channel || ''),
                    start: String(attr.start || ''),
                    stop: String(attr.stop || ''),
                    title: ''
                };
            } else if (name === 'icon') {
                const src = String(attr.src || '');
                if (currentChannel) currentChannel.icon = src;
                else if (currentProgramme) currentProgramme.icon = src;
            } else if (currentChannel && name === 'display-name') {
                textTarget = 'display-name';
            } else if (currentProgramme) {
                if (['title', 'desc', 'sub-title', 'episode-num', 'category', 'value'].includes(name)) {
                    textTarget = name;
                }
            }
        };

        parser.ontext = (text: string) => {
            if (!textTarget) return;
            const value = text.trim();
            if (!value) return;

            if (currentChannel && textTarget === 'display-name' && !currentChannel.displayName) {
                currentChannel.displayName = value;
            } else if (currentProgramme) {
                switch (textTarget) {
                    case 'title': currentProgramme.title ||= value; break;
                    case 'desc': currentProgramme.desc ||= value; break;
                    case 'sub-title': currentProgramme.subTitle ||= value; break;
                    case 'episode-num': currentProgramme.episodeNum ||= value; break;
                    case 'category':
                        currentProgramme.category = currentProgramme.category
                            ? `${currentProgramme.category}, ${value}`
                            : value;
                        break;
                    case 'value': currentProgramme.rating ||= value; break;
                }
            }
        };

        parser.onclosetag = (tagName: string) => {
            const name = String(tagName).toLowerCase();
            if (name === 'channel' && currentChannel) {
                if (currentChannel.id) channels.push(currentChannel);
                currentChannel = null;
            } else if (name === 'programme' && currentProgramme) {
                if (currentProgramme.channelId && currentProgramme.start) {
                    if (programmes.length < limit) programmes.push(currentProgramme);
                    else truncated = true;
                }
                currentProgramme = null;
            }
            textTarget = null;
        };

        parser.onerror = (err: Error) => {
            parser.resume();
            reject(err);
        };
        parser.onend = () => resolve({ channels, programmes, truncated });

        input.on('data', (chunk: Buffer | string) => parser.write(chunk.toString()));
        input.on('error', reject);
        input.on('end', () => parser.close());
    });
}

/**
 * One fetch per context, shared by syncCatalog and fetchGuide.
 *
 * A whole-feed kind derives both its catalogue and its programmes from the same
 * document. Fetching twice would double the bandwidth and — because the first
 * fetch stores the conditional validators — make the second answer 304 and
 * return nothing.
 */
const feedCache = new WeakMap<object, Map<string, XmltvParseResult | null>>();

async function fetchAndParse(
    descriptor: SourceDescriptor,
    ctx: AdapterContext,
    limit?: number
): Promise<{ parsed: XmltvParseResult | null; notModified: boolean }> {
    const url = descriptor.fetch.url;
    if (!url) throw new Error('XMLTV source has no url');

    // A limited read is a sample, never cached as if it were the whole feed.
    if (limit === undefined) {
        const perContext = feedCache.get(ctx as object);
        if (perContext?.has(url)) {
            const cached = perContext.get(url)!;
            return { parsed: cached, notModified: cached === null };
        }
    }

    const result = await ctx.fetch(url, {
        maxBytes: descriptor.fetch.maxBytes,
        timeoutMs: descriptor.fetch.timeoutMs,
        gzip: descriptor.fetch.compression === 'gzip'
    });

    let parsed: XmltvParseResult | null = null;
    if (!result.notModified && result.body) {
        parsed = await parseXmltv(Readable.from(result.body), { limit });
    }

    if (limit === undefined) {
        const perContext = feedCache.get(ctx as object) || new Map();
        perContext.set(url, parsed);
        feedCache.set(ctx as object, perContext);
    }

    return { parsed, notModified: parsed === null };
}

export const xmltvAdapter: SourceAdapter = {
    kind: 'xmltv',

    async probe(descriptor, ctx): Promise<ProbeResult> {
        try {
            const { parsed, notModified } = await fetchAndParse(descriptor, ctx, 200);
            if (notModified || !parsed) {
                return {
                    ok: true, provides: ['guide'], sample: {}, counts: {},
                    warnings: ['Source reports no change since the last fetch']
                };
            }

            const warnings: string[] = [];
            if (parsed.channels.length === 0) warnings.push('Feed declares no channels');
            if (parsed.programmes.length === 0) warnings.push('Feed contains no programmes');

            const days = guideWindowDays(parsed.programmes);
            if (days !== null && days < 1) {
                warnings.push('Feed covers less than a day of programming');
            }

            return {
                ok: parsed.channels.length > 0 || parsed.programmes.length > 0,
                provides: ['guide'],
                detectedKind: 'xmltv',
                sample: { programmes: parsed.programmes.slice(0, 5) },
                counts: {
                    channels: parsed.channels.length,
                    programmes: parsed.truncated ? undefined : parsed.programmes.length,
                    days: days ?? undefined
                },
                warnings
            };
        } catch (e: any) {
            return {
                ok: false, provides: [], sample: {}, counts: {}, warnings: [],
                error: { code: 'FETCH_FAILED', message: e.message }
            };
        }
    },

    /** The feed's own channel list is its catalogue. */
    async syncCatalog(descriptor, ctx): Promise<CatalogResult> {
        const { parsed, notModified } = await fetchAndParse(descriptor, ctx);
        if (notModified || !parsed) {
            return { rows: [], notModified: true, warnings: [] };
        }

        const site = hostOf(descriptor.fetch.url || descriptor.id);
        const rows: CatalogRow[] = parsed.channels.map(channel => ({
            name: channel.displayName || channel.id,
            xmltvId: channel.id,
            site,
            siteId: channel.id,
            lang: descriptor.coverage?.languages?.[0] || 'en'
        }));

        ctx.log(`${descriptor.label}: catalogued ${rows.length} channel(s)`, 'info');
        return {
            rows,
            notModified: false,
            warnings: rows.length === 0 ? ['Feed declares no channels'] : []
        };
    },

    /**
     * Whole-feed kind: `refs` is ignored, the feed is taken in full and
     * programmes are yielded for the channels it covers.
     */
    async *fetchGuide(
        descriptor: SourceDescriptor,
        refs: ChannelRef[],
        _window: Window,
        ctx: AdapterContext
    ): AsyncIterable<ProgrammeRow> {
        const { parsed, notModified } = await fetchAndParse(descriptor, ctx);
        if (notModified || !parsed) {
            ctx.log(`${descriptor.label}: unchanged since last fetch`, 'info');
            return;
        }

        // When the caller named channels, only their programmes are wanted.
        const wanted = refs.length > 0 ? new Set(refs.map(ref => ref.xmltvId)) : null;

        for (const programme of parsed.programmes) {
            if (wanted && !wanted.has(programme.channelId)) continue;
            yield programme;
        }
    }
};

/** Days of coverage in a feed, from the earliest start to the latest stop. */
export function guideWindowDays(programmes: ProgrammeRow[]): number | null {
    const times = programmes
        .map(programme => parseXmltvTime(programme.start))
        .filter((value): value is number => value !== null);
    if (times.length === 0) return null;

    const stops = programmes
        .map(programme => parseXmltvTime(programme.stop))
        .filter((value): value is number => value !== null);
    const latest = stops.length > 0 ? Math.max(...stops) : Math.max(...times);

    return (latest - Math.min(...times)) / 86_400_000;
}

/** `20260814120000 +0000` -> epoch millis. */
export function parseXmltvTime(value: string | undefined): number | null {
    if (!value) return null;
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(value.trim());
    if (!match) return null;
    const [, y, mo, d, h, mi, sec, tz] = match;
    const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
    const parsed = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec || '00'}${offset}`);
    return Number.isNaN(parsed) ? null : parsed;
}

function hostOf(value: string): string {
    try { return new URL(value).hostname; } catch { return value; }
}

/**
 * Write programmes for a source, replacing only that source's rows.
 * Provenance is what makes a direct feed removable without disturbing
 * scraped data for the same channels.
 */
export async function persistProgrammes(
    sourceKey: string,
    channels: XmltvChannel[],
    programmes: ProgrammeRow[]
): Promise<{ channels: number; programmes: number }> {
    await db.execute({ sql: 'DELETE FROM epg_programs WHERE source = ?', args: [sourceKey] });
    await db.execute({ sql: 'DELETE FROM epg_channels WHERE source = ?', args: [sourceKey] });

    const CHUNK = 250;

    for (let i = 0; i < channels.length; i += CHUNK) {
        const chunk = channels.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(',');
        await db.execute({
            sql: `INSERT OR IGNORE INTO epg_channels (id, source, display_name, icon) VALUES ${placeholders}`,
            args: chunk.flatMap(c => [c.id, sourceKey, c.displayName || c.id, c.icon || ''])
        });
    }

    for (let i = 0; i < programmes.length; i += CHUNK) {
        const chunk = programmes.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
        await db.execute({
            sql: `INSERT INTO epg_programs
                    (channel_id, source, start, stop, title, desc, sub_title, episode_num, category, rating, icon)
                  VALUES ${placeholders}`,
            args: chunk.flatMap(p => [
                p.channelId, sourceKey, p.start, p.stop, p.title,
                p.desc || '', p.subTitle || '', p.episodeNum || '',
                p.category || '', p.rating || '', p.icon || ''
            ])
        });
    }

    return { channels: channels.length, programmes: programmes.length };
}
