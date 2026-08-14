/**
 * Source descriptors — a source is a document, not a code path.
 *
 * Today acquisition is hardwired: two iptv-org repositories and six literal
 * FAST urls spread across three files, so adding a provider means editing
 * TypeScript. A descriptor names an adapter kind and its parameters, which
 * makes adding a source a data operation. Built-ins ship as a catalogue of
 * these; user-added sources are the same shape, so they export and import.
 *
 * This module is pure: validation, normalisation, redaction and the built-in
 * catalogue. Storage lives in the registry, fetching lives in the adapters.
 */

/** How a source is reached. The only axis that needs code to extend. */
export type SourceKind = 'm3u' | 'xmltv' | 'bundle' | 'scraper-repo' | 'xtream' | 'file';

/** What a source supplies. A source may supply both. */
export type SourceCapability = 'channels' | 'guide';

export const SOURCE_KINDS: readonly SourceKind[] = ['m3u', 'xmltv', 'bundle', 'scraper-repo', 'xtream', 'file'];
export const SOURCE_CAPABILITIES: readonly SourceCapability[] = ['channels', 'guide'];

export interface FetchSpec {
    url?: string;
    compression?: 'none' | 'gzip';
    /** Refresh cadence, e.g. "12h". Parsed by parseDuration. */
    refresh?: string;
    /** Send If-None-Match / If-Modified-Since so an unchanged feed costs a 304. */
    conditional?: boolean;
    maxBytes?: number;
    timeoutMs?: number;
}

export interface SourceDescriptor {
    id: string;
    kind: SourceKind;
    label: string;
    provides: SourceCapability[];
    enabled: boolean;
    priority: number;
    fetch: FetchSpec;
    /** Reference into the credential store — never the secret itself. */
    credentialRef?: string | null;
    identity?: { idStyle?: string; idPrefix?: string | null };
    coverage?: { region?: string; languages?: string[] };
    notes?: string;
}

export const DEFAULT_FETCH: Required<Pick<FetchSpec, 'compression' | 'refresh' | 'conditional' | 'maxBytes' | 'timeoutMs'>> = {
    compression: 'none',
    refresh: '12h',
    conditional: true,
    maxBytes: 512 * 1024 * 1024,
    timeoutMs: 120000
};

export function isSourceKind(value: unknown): value is SourceKind {
    return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

export function isSourceCapability(value: unknown): value is SourceCapability {
    return typeof value === 'string' && (SOURCE_CAPABILITIES as readonly string[]).includes(value);
}

/** "12h" / "45m" / "7d" / "30s" → milliseconds. Null when unparseable. */
export function parseDuration(value: string | undefined): number | null {
    if (!value) return null;
    const match = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const scale: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return amount * scale[unit];
}

export function slugifySourceId(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'source';
}

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validate a descriptor before it is stored or acted on. Deliberately strict:
 * a malformed descriptor should be rejected at the door rather than surface
 * later as a source that silently never fetches.
 */
export function validateDescriptor(input: unknown): ValidationResult {
    const errors: string[] = [];
    const d = input as Partial<SourceDescriptor> | null;

    if (!d || typeof d !== 'object') {
        return { valid: false, errors: ['Descriptor must be an object'] };
    }

    if (!d.id || typeof d.id !== 'string' || !d.id.trim()) {
        errors.push('id is required');
    }
    if (!isSourceKind(d.kind)) {
        errors.push(`kind must be one of: ${SOURCE_KINDS.join(', ')}`);
    }
    if (!d.label || typeof d.label !== 'string' || !d.label.trim()) {
        errors.push('label is required');
    }

    if (!Array.isArray(d.provides) || d.provides.length === 0) {
        errors.push('provides must list at least one of: channels, guide');
    } else if (!d.provides.every(isSourceCapability)) {
        errors.push('provides may only contain: channels, guide');
    }

    if (d.priority !== undefined && (typeof d.priority !== 'number' || !Number.isFinite(d.priority))) {
        errors.push('priority must be a number');
    }

    const fetchSpec = d.fetch;
    if (fetchSpec && typeof fetchSpec !== 'object') {
        errors.push('fetch must be an object');
    } else if (fetchSpec) {
        // Every kind except `file` is reached over the network or the local
        // data directory, so it needs somewhere to read from.
        if (d.kind !== 'file' && !fetchSpec.url) {
            errors.push(`fetch.url is required for kind "${d.kind}"`);
        }
        if (fetchSpec.url && typeof fetchSpec.url === 'string' && !isAcceptableUrl(fetchSpec.url)) {
            errors.push('fetch.url must be http(s) or a /files/ path');
        }
        if (fetchSpec.refresh !== undefined && parseDuration(fetchSpec.refresh) === null) {
            errors.push('fetch.refresh must look like "30s", "45m", "12h" or "7d"');
        }
        if (fetchSpec.compression !== undefined && !['none', 'gzip'].includes(fetchSpec.compression)) {
            errors.push('fetch.compression must be "none" or "gzip"');
        }
    } else if (d.kind !== 'file') {
        errors.push(`fetch is required for kind "${d.kind}"`);
    }

    return { valid: errors.length === 0, errors };
}

function isAcceptableUrl(url: string): boolean {
    if (url.startsWith('/files/')) return true;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/** Fill defaults so callers never have to test for absent fetch options. */
export function normalizeDescriptor(input: SourceDescriptor): SourceDescriptor {
    return {
        ...input,
        id: slugifySourceId(input.id),
        enabled: input.enabled !== false,
        priority: Number.isFinite(input.priority) ? input.priority : 0,
        provides: [...new Set(input.provides)],
        credentialRef: input.credentialRef ?? null,
        fetch: { ...DEFAULT_FETCH, ...(input.fetch || {}) }
    };
}

/** Credential-bearing fields, stripped before a descriptor leaves the server. */
const SECRET_KEYS = ['password', 'passwd', 'secret', 'token', 'apiKey', 'api_key', 'auth'];

/**
 * Remove anything credential-shaped from a descriptor and redact credentials
 * embedded in a url's userinfo. Applied on every API response and log line —
 * a source's secret should never be readable back out of the system.
 */
export function redactDescriptor(descriptor: SourceDescriptor): SourceDescriptor {
    const clone: any = { ...descriptor, fetch: { ...descriptor.fetch } };

    for (const key of Object.keys(clone)) {
        if (SECRET_KEYS.includes(key)) delete clone[key];
    }
    for (const key of Object.keys(clone.fetch)) {
        if (SECRET_KEYS.includes(key)) delete clone.fetch[key];
    }
    if (clone.fetch.url) {
        clone.fetch.url = redactUrl(clone.fetch.url);
    }
    if (clone.credentialRef) {
        clone.hasCredentials = true;
    }
    return clone;
}

/** Strip userinfo and common secret query params from a url for display. */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '';
        }
        for (const key of [...parsed.searchParams.keys()]) {
            if (SECRET_KEYS.includes(key.toLowerCase()) || /pass|token|secret/i.test(key)) {
                parsed.searchParams.set(key, '***');
            }
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

/** Is this source due for a refresh? */
export function isRefreshDue(descriptor: SourceDescriptor, lastSyncAt: number | null, now: number): boolean {
    if (!descriptor.enabled) return false;
    if (!lastSyncAt) return true;
    const interval = parseDuration(descriptor.fetch.refresh) ?? parseDuration(DEFAULT_FETCH.refresh)!;
    return now - lastSyncAt >= interval;
}
