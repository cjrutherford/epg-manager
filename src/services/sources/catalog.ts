/**
 * The built-in source catalogue.
 *
 * These descriptors used to be three separate hardcoded lists: FAST_PRESETS in
 * server.ts, the branching in describePlaylist(), and a hand-copied set of
 * buttons in the Settings template — each with its own channel-count estimates.
 * They are one list now, and the API serves it, so adding a well-known provider
 * is a JSON-shaped edit in a single file.
 */

import type { SourceDescriptor } from './descriptor';

export interface BuiltInSource extends SourceDescriptor {
    /** Rough size, shown before a user commits to importing it. */
    channelCountEstimate: number | null;
    category: 'fast' | 'guide';
    host: string;
}

/**
 * Free ad-supported streaming platforms. Channel-providing; their guide data
 * comes from the matching guide sources below.
 */
const FAST_SOURCES: BuiltInSource[] = [
    {
        id: 'fast-plutotv', kind: 'm3u', label: 'Pluto TV', provides: ['channels'],
        enabled: false, priority: 0, category: 'fast', host: 'i.mjh.nz', channelCountEstimate: 350,
        fetch: { url: 'https://i.mjh.nz/PlutoTV/all.m3u8', refresh: '12h', conditional: true }
    },
    {
        id: 'fast-samsungtvplus', kind: 'm3u', label: 'Samsung TV Plus', provides: ['channels'],
        enabled: false, priority: 0, category: 'fast', host: 'i.mjh.nz', channelCountEstimate: 280,
        fetch: { url: 'https://i.mjh.nz/SamsungTVPlus/all.m3u8', refresh: '12h', conditional: true }
    },
    {
        id: 'fast-roku', kind: 'm3u', label: 'Roku Channel', provides: ['channels'],
        enabled: false, priority: 0, category: 'fast', host: 'i.mjh.nz', channelCountEstimate: 300,
        fetch: { url: 'https://i.mjh.nz/Roku/all.m3u8', refresh: '12h', conditional: true }
    },
    {
        id: 'fast-plex', kind: 'm3u', label: 'Plex TV', provides: ['channels'],
        enabled: false, priority: 0, category: 'fast', host: 'i.mjh.nz', channelCountEstimate: 250,
        fetch: { url: 'https://i.mjh.nz/Plex/all.m3u8', refresh: '12h', conditional: true }
    },
    {
        id: 'fast-pbs', kind: 'm3u', label: 'PBS Live', provides: ['channels'],
        enabled: false, priority: 0, category: 'fast', host: 'i.mjh.nz', channelCountEstimate: 120,
        fetch: { url: 'https://i.mjh.nz/PBS/all.m3u8', refresh: '12h', conditional: true }
    },
    {
        id: 'fast-stirr', kind: 'm3u', label: 'Stirr TV', provides: ['channels'],
        enabled: false, priority: 0, category: 'fast', host: 'i.mjh.nz', channelCountEstimate: 100,
        fetch: { url: 'https://i.mjh.nz/Stirr/all.m3u8', refresh: '12h', conditional: true }
    }
];

/**
 * EPGShare 01's regional XMLTV feeds. These were defined in epg-sources.ts and
 * never fetched by anything — the accessor had no callers (R2). They are
 * ordinary catalogue entries now, wired up by the xmltv adapter in S16b.
 */
const EPGSHARE_TAGS: Array<{ tag: string; label: string; region: string }> = [
    { tag: 'US1', label: 'EPGShare 01 — United States', region: 'US' },
    { tag: 'CA1', label: 'EPGShare 01 — Canada', region: 'CA' },
    { tag: 'UK1', label: 'EPGShare 01 — United Kingdom', region: 'GB' },
    { tag: 'PLUTO1', label: 'EPGShare 01 — Pluto TV', region: 'US' },
    { tag: 'ROKU1', label: 'EPGShare 01 — Roku', region: 'US' },
    { tag: 'SAMSUNG1', label: 'EPGShare 01 — Samsung TV Plus', region: 'US' },
    { tag: 'PLEX1', label: 'EPGShare 01 — Plex', region: 'US' },
    { tag: 'TUBI1', label: 'EPGShare 01 — Tubi', region: 'US' },
    { tag: 'DISTROTV1', label: 'EPGShare 01 — DistroTV', region: 'US' },
    { tag: 'STIRR1', label: 'EPGShare 01 — Stirr', region: 'US' }
];

const GUIDE_SOURCES: BuiltInSource[] = EPGSHARE_TAGS.map(({ tag, label, region }) => ({
    id: `epgshare01-${tag.toLowerCase()}`,
    kind: 'xmltv' as const,
    label,
    provides: ['guide' as const],
    enabled: false,
    priority: 90,
    category: 'guide' as const,
    host: 'epgshare01.online',
    channelCountEstimate: null,
    coverage: { region },
    fetch: {
        url: `https://epgshare01.online/epgshare01/epg_ripper_${tag}.xml.gz`,
        compression: 'gzip' as const,
        refresh: '12h',
        conditional: true
    }
}));

const BUILT_IN: BuiltInSource[] = [...FAST_SOURCES, ...GUIDE_SOURCES];

export function getBuiltInCatalog(): BuiltInSource[] {
    return BUILT_IN.map(source => ({
        ...source,
        provides: [...source.provides],
        fetch: { ...source.fetch }
    }));
}

export function getBuiltInSource(id: string): BuiltInSource | null {
    return getBuiltInCatalog().find(source => source.id === id) || null;
}

/** Look up a built-in by its fetch url — used to describe an already-configured playlist. */
export function findBuiltInByUrl(url: string): BuiltInSource | null {
    if (!url) return null;
    const normalized = url.trim().toLowerCase();
    return getBuiltInCatalog().find(source =>
        (source.fetch.url || '').toLowerCase() === normalized
    ) || null;
}

export function getFastSources(): BuiltInSource[] {
    return getBuiltInCatalog().filter(source => source.category === 'fast');
}

export function getGuideSources(): BuiltInSource[] {
    return getBuiltInCatalog().filter(source => source.category === 'guide');
}
