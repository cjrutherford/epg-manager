/**
 * The adapter contract.
 *
 * Every upstream shape — a scraper repo, an M3U over HTTP, an archive of
 * playlists, a direct XMLTV feed, a panel API — reaches the system through
 * this one interface. Nothing above the adapter layer knows what a site config
 * or a panel API is, so fetching, caching, staging and health reporting are
 * written once instead of per provider.
 *
 * Adding a source of an existing kind is a descriptor; adding a new protocol is
 * one file implementing this.
 */

import type { SourceDescriptor } from './descriptor';

/** A channel as supplied by a channel-providing source. */
export interface ChannelRow {
    name: string;
    url: string;
    tvgId: string;
    tvgLogo: string;
    groupTitle: string;
    lang?: string;
}

/** A catalogue entry — what a guide source carries, before any grab. */
export interface CatalogRow {
    name: string;
    xmltvId: string;
    site: string;
    siteId: string;
    lang: string;
}

/** A programme as supplied by a guide-providing source. */
export interface ProgrammeRow {
    channelId: string;
    start: string;
    stop: string;
    title: string;
    desc?: string;
    subTitle?: string;
    episodeNum?: string;
    category?: string;
    rating?: string;
    icon?: string;
}

export interface ChannelRef {
    xmltvId: string;
    siteId: string;
    site: string;
    lang: string;
}

export interface Window {
    days: number;
}

/** Everything an adapter is given. Adapters never construct their own client. */
export interface AdapterContext {
    /** Shared HTTP client: conditional GET, byte caps, timeouts, backoff. */
    fetch: SourceFetcher;
    /**
     * Streaming variant, for line-oriented formats that must not be buffered.
     * Same caching and validator handling as `fetch`.
     */
    fetchStream: (url: string, options?: {
        etag?: string | null;
        lastModified?: string | null;
        maxBytes?: number;
        timeoutMs?: number;
        gzip?: boolean;
    }) => Promise<StreamFetchResult>;
    /** Resolved credential for this source, if it has one. */
    credentials?: Record<string, string> | null;
    log: (message: string, level?: 'info' | 'warning' | 'error' | 'success') => void;
    signal?: AbortSignal;
}

export interface FetchResult {
    /** True when the upstream answered 304 — nothing changed, nothing to parse. */
    notModified: boolean;
    status: number;
    body?: Buffer;
    etag?: string | null;
    lastModified?: string | null;
    bytes: number;
}

export interface StreamFetchResult {
    notModified: boolean;
    status: number;
    stream?: NodeJS.ReadableStream;
    etag?: string | null;
    lastModified?: string | null;
}

export interface SourceFetcher {
    (url: string, options?: {
        etag?: string | null;
        lastModified?: string | null;
        maxBytes?: number;
        timeoutMs?: number;
        gzip?: boolean;
    }): Promise<FetchResult>;
}

export interface ProbeResult {
    ok: boolean;
    provides: ('channels' | 'guide')[];
    detectedKind?: string;
    sample: { channels?: ChannelRow[]; programmes?: ProgrammeRow[] };
    counts: { channels?: number; programmes?: number; days?: number };
    /** Things worth telling the user before they commit: no ids, no logos, an expired window. */
    warnings: string[];
    error?: { code: string; message: string };
}

export interface CatalogResult {
    /** Rows the core will stage and then swap in. */
    rows: CatalogRow[];
    notModified: boolean;
    warnings: string[];
}

export interface SourceAdapter {
    kind: SourceDescriptor['kind'];

    /** Add-source flow: what is this, and is it usable? Never writes. */
    probe(descriptor: SourceDescriptor, ctx: AdapterContext): Promise<ProbeResult>;

    /** Refresh the catalogue of what this source carries. */
    syncCatalog?(descriptor: SourceDescriptor, ctx: AdapterContext): Promise<CatalogResult>;

    /** Channel-providing sources only. */
    fetchLineup?(descriptor: SourceDescriptor, ctx: AdapterContext): AsyncIterable<ChannelRow>;

    /**
     * Guide-providing sources only. `refs` is empty for whole-feed kinds
     * (xmltv, xtream) and populated for per-channel kinds (scraper-repo).
     */
    fetchGuide?(
        descriptor: SourceDescriptor,
        refs: ChannelRef[],
        window: Window,
        ctx: AdapterContext
    ): AsyncIterable<ProgrammeRow>;
}

const registry = new Map<string, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
    registry.set(adapter.kind, adapter);
}

export function getAdapter(kind: string): SourceAdapter | null {
    return registry.get(kind) || null;
}

export function registeredKinds(): string[] {
    return [...registry.keys()].sort();
}
