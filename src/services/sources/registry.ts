/**
 * The source registry — reading and writing sources as descriptors.
 *
 * Everything the Sources screen needs sits here: listing both families with
 * their health, probing before committing, adding, toggling, removing, and
 * round-tripping a configuration as portable descriptors.
 */

import { db } from '../../db';
import {
    normalizeDescriptor,
    redactDescriptor,
    redactUrl,
    slugifySourceId,
    validateDescriptor,
    type SourceCapability,
    type SourceDescriptor,
    type SourceKind
} from './descriptor';

export interface SourceRecord {
    key: string;
    kind: SourceKind | null;
    label: string;
    provider: string;
    site: string;
    provides: SourceCapability[];
    enabled: boolean;
    priority: number;
    importedRows: number;
    channelCountEstimate: number | null;
    lastSyncAt: number | null;
    lastSyncStatus: string | null;
    lastError: string | null;
    hasCredentials: boolean;
    /** Redacted — never the stored value. */
    url: string | null;
    notes: string;
}

function parseProvides(value: unknown): SourceCapability[] {
    if (!value) return [];
    return String(value)
        .split(',')
        .map(part => part.trim())
        .filter((part): part is SourceCapability => part === 'channels' || part === 'guide');
}

function descriptorFrom(configJson: unknown): SourceDescriptor | null {
    if (!configJson) return null;
    try { return JSON.parse(String(configJson)) as SourceDescriptor; } catch { return null; }
}

function toRecord(row: Record<string, any>): SourceRecord {
    const descriptor = descriptorFrom(row.config_json);
    const url = descriptor?.fetch?.url ? redactUrl(descriptor.fetch.url) : null;

    return {
        key: String(row.key),
        kind: (row.kind as SourceKind) || null,
        label: String(row.label || row.site || row.key),
        provider: String(row.provider || ''),
        site: String(row.site || ''),
        provides: parseProvides(row.provides),
        enabled: Number(row.enabled) === 1,
        priority: Number(row.priority) || 0,
        importedRows: Number(row.imported_rows) || 0,
        channelCountEstimate: row.channel_count_estimate === null || row.channel_count_estimate === undefined
            ? null
            : Number(row.channel_count_estimate),
        lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
        lastSyncStatus: row.last_sync_status ? String(row.last_sync_status) : null,
        lastError: row.last_error ? String(row.last_error) : null,
        hasCredentials: !!row.credential_ref,
        url,
        notes: String(row.notes || '')
    };
}

export async function listSources(): Promise<SourceRecord[]> {
    const result = await db.execute(`
        SELECT key, kind, label, provider, site, provides, enabled, priority,
               imported_rows, channel_count_estimate, last_sync_at, last_sync_status,
               last_error, credential_ref, config_json, notes
        FROM sources
        ORDER BY priority DESC, label ASC
    `);
    return result.rows.map(row => toRecord(row as Record<string, any>));
}

export async function getSourceDescriptor(key: string): Promise<SourceDescriptor | null> {
    const result = await db.execute({
        sql: 'SELECT config_json FROM sources WHERE key = ?',
        args: [key]
    });
    if (result.rows.length === 0) return null;
    return descriptorFrom(result.rows[0].config_json);
}

export interface AddResult {
    ok: boolean;
    key?: string;
    errors?: string[];
}

/** Store a descriptor as a source. Rejects anything that would not work. */
export async function addSource(input: Partial<SourceDescriptor>): Promise<AddResult> {
    const validation = validateDescriptor(input);
    if (!validation.valid) {
        return { ok: false, errors: validation.errors };
    }

    const descriptor = normalizeDescriptor(input as SourceDescriptor);
    const key = descriptor.id;

    const existing = await db.execute({ sql: 'SELECT key FROM sources WHERE key = ?', args: [key] });
    if (existing.rows.length > 0) {
        return { ok: false, errors: [`A source with id "${key}" already exists`] };
    }

    let site = 'local';
    try {
        if (descriptor.fetch.url) site = new URL(descriptor.fetch.url).hostname;
    } catch { /* a /files/ path or an upload */ }

    await db.execute({
        sql: `INSERT INTO sources
                (key, provider, site, label, enabled, priority, grab_capable,
                 kind, provides, config_json, credential_ref, last_sync_status, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [
            key,
            descriptor.kind,
            site,
            descriptor.label,
            descriptor.enabled ? 1 : 0,
            descriptor.priority,
            descriptor.provides.includes('guide') ? 1 : 0,
            descriptor.kind,
            descriptor.provides.join(','),
            JSON.stringify(descriptor),
            descriptor.credentialRef ?? null,
            descriptor.notes || ''
        ]
    });

    return { ok: true, key };
}

export async function setSourceEnabled(key: string, enabled: boolean): Promise<boolean> {
    const result = await db.execute({
        sql: 'UPDATE sources SET enabled = ? WHERE key = ?',
        args: [enabled ? 1 : 0, key]
    });
    return (result.rowsAffected || 0) > 0;
}

export async function setSourcePriority(key: string, priority: number): Promise<boolean> {
    const result = await db.execute({
        sql: 'UPDATE sources SET priority = ? WHERE key = ?',
        args: [priority, key]
    });
    return (result.rowsAffected || 0) > 0;
}

/**
 * Remove a source and the data it supplied.
 *
 * Provenance is what makes this safe: only rows attributed to this source are
 * deleted, so other sources covering the same channels are untouched.
 */
export async function removeSource(key: string): Promise<{ removed: boolean; programmes: number }> {
    const existing = await db.execute({ sql: 'SELECT key FROM sources WHERE key = ?', args: [key] });
    if (existing.rows.length === 0) return { removed: false, programmes: 0 };

    const programmes = await db.execute({
        sql: 'SELECT COUNT(*) as c FROM epg_programs WHERE source = ?',
        args: [key]
    });

    await db.execute({ sql: 'DELETE FROM epg_programs WHERE source = ?', args: [key] });
    await db.execute({ sql: 'DELETE FROM epg_channels WHERE source = ?', args: [key] });
    await db.execute({ sql: 'DELETE FROM epg_source_channels WHERE source_key = ?', args: [key] });
    await db.execute({ sql: 'DELETE FROM epg_source_channels_staging WHERE source_key = ?', args: [key] });
    await db.execute({ sql: 'DELETE FROM source_validators WHERE source_key = ?', args: [key] });
    await db.execute({ sql: 'DELETE FROM sources WHERE key = ?', args: [key] });

    return { removed: true, programmes: Number(programmes.rows[0]?.c || 0) };
}

/** Descriptors for every configured source, redacted and portable. */
export async function exportSources(): Promise<SourceDescriptor[]> {
    const result = await db.execute('SELECT config_json FROM sources WHERE config_json IS NOT NULL');
    return result.rows
        .map(row => descriptorFrom(row.config_json))
        .filter((descriptor): descriptor is SourceDescriptor => descriptor !== null)
        .map(redactDescriptor);
}

export interface ImportSummary {
    added: number;
    skipped: number;
    errors: { id: string; errors: string[] }[];
}

/** Add descriptors from an export, skipping any that already exist. */
export async function importSources(descriptors: unknown[]): Promise<ImportSummary> {
    const summary: ImportSummary = { added: 0, skipped: 0, errors: [] };

    for (const entry of descriptors) {
        const id = (entry as any)?.id ? slugifySourceId(String((entry as any).id)) : '(no id)';
        const result = await addSource(entry as Partial<SourceDescriptor>);

        if (result.ok) {
            summary.added++;
        } else if (result.errors?.some(message => message.includes('already exists'))) {
            summary.skipped++;
        } else {
            summary.errors.push({ id, errors: result.errors || ['Unknown error'] });
        }
    }

    return summary;
}
