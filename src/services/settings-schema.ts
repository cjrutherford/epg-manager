/**
 * One definition of every configurable setting: its type, its default, and what
 * counts as valid.
 *
 * There were two endpoints returning overlapping, differently-shaped views of
 * the same `settings` table. `/api/settings` defaulted `metadata_enrichment_enabled`
 * and `/api/config` did not; `/api/config` parsed `playlist_urls` into an array
 * and `/api/settings` returned the raw JSON string. Whichever screen asked
 * first decided what the application believed.
 *
 * Values are stored as TEXT, so every definition owns both directions: how to
 * read a stored string into a typed value, and how to write a typed value back.
 */

import { isValidCron } from './cron-schedule';

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'json-array' | 'cron';

export interface SettingDefinition {
    key: string;
    type: SettingType;
    /** Applied when the row is absent, empty, or unreadable. */
    default: unknown;
    /** Allowed values, for `enum`. */
    values?: readonly string[];
    min?: number;
    max?: number;
    /** Extra rule beyond the type, returning a message when it fails. */
    check?: (value: any) => string | null;
    /** Shown to the user when the value is rejected. */
    description: string;
}

export const CHANNEL_NUMBERING_MODES = ['list', 'auto-group', 'custom-ranges'] as const;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
    {
        key: 'playlist_urls',
        type: 'json-array',
        default: [],
        description: 'Playlist URLs to import channels from'
    },
    {
        key: 'preferred_lang',
        type: 'string',
        default: 'en',
        // Empty means "no preference", which the selector offers and the
        // grabber has always treated as unset.
        check: value => (String(value) === '' || /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(String(value))
            ? null
            : 'must be a language code such as "en" or "pt-BR"'),
        description: 'Preferred guide language'
    },
    {
        key: 'epg_days',
        type: 'number',
        default: 2,
        min: 1,
        max: 14,
        description: 'Days of guide data to grab'
    },
    {
        key: 'channel_numbering_mode',
        type: 'enum',
        values: CHANNEL_NUMBERING_MODES,
        default: 'list',
        description: 'How channel numbers are assigned'
    },
    {
        key: 'custom_channel_ranges',
        type: 'json-array',
        default: {},
        description: 'Per-category starting numbers'
    },
    {
        key: 'metadata_enrichment_enabled',
        type: 'boolean',
        default: true,
        description: 'Look up extra programme metadata'
    },
    {
        key: 'sync_cron',
        type: 'cron',
        default: '0 2,14 * * *',
        description: 'When the automatic sync runs'
    },
    {
        key: 'dvr_retention_mode',
        type: 'enum',
        values: ['off', 'age', 'size', 'low-space'],
        default: 'age',
        description: 'When recordings are deleted'
    },
    {
        key: 'dvr_retention_days',
        type: 'number',
        default: 30,
        min: 1,
        max: 3650,
        description: 'How long recordings are kept'
    },
    {
        key: 'dvr_size_budget_gb',
        type: 'number',
        default: 50,
        min: 1,
        description: 'Disk budget for recordings'
    },
    {
        key: 'dvr_min_free_gb',
        type: 'number',
        default: 2,
        min: 0,
        description: 'Free space to preserve'
    },
    {
        key: 'dvr_padding_start_seconds',
        type: 'number',
        default: 0,
        min: 0,
        max: 3600,
        description: 'Seconds to start recording early'
    },
    {
        key: 'dvr_padding_end_seconds',
        type: 'number',
        default: 120,
        min: 0,
        max: 3600,
        description: 'Seconds to keep recording after'
    },
    {
        key: 'max_active_streams',
        type: 'number',
        default: 6,
        min: 1,
        max: 64,
        description: 'Concurrent transcodes allowed'
    }
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map(d => [d.key, d]));

export function getSettingDefinition(key: string): SettingDefinition | undefined {
    return BY_KEY.get(key);
}

export function isKnownSetting(key: string): boolean {
    return BY_KEY.has(key);
}

/** Read a stored TEXT value into its typed form, falling back to the default. */
export function parseSetting(definition: SettingDefinition, raw: string | null | undefined): unknown {
    if (raw === null || raw === undefined || String(raw).trim() === '') return definition.default;
    const text = String(raw);

    switch (definition.type) {
        case 'number': {
            const value = Number(text);
            return Number.isFinite(value) ? value : definition.default;
        }
        case 'boolean':
            return text === 'true' || text === '1';
        case 'enum':
            return definition.values?.includes(text) ? text : definition.default;
        case 'cron':
            return isValidCron(text) ? text : definition.default;
        case 'json-array':
            try {
                return JSON.parse(text);
            } catch {
                return definition.default;
            }
        default:
            return text;
    }
}

/** Convert a typed value into the TEXT actually stored. */
export function serializeSetting(definition: SettingDefinition, value: unknown): string {
    switch (definition.type) {
        case 'boolean':
            return value ? 'true' : 'false';
        case 'json-array':
            return typeof value === 'string' ? value : JSON.stringify(value);
        case 'number':
            return String(Math.floor(Number(value)));
        default:
            return String(value);
    }
}

/**
 * Build the full configuration from whatever rows exist, applying every default
 * in one place. This is the only shape any endpoint should return.
 */
export function applyDefaults(rows: Record<string, string | null>): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const definition of SETTING_DEFINITIONS) {
        config[definition.key] = parseSetting(definition, rows[definition.key]);
    }

    // Settings not in the schema are still returned, so nothing silently
    // disappears from a database that predates it.
    for (const [key, value] of Object.entries(rows)) {
        if (!BY_KEY.has(key) && !(key in config)) config[key] = value;
    }

    return config;
}

export interface FieldError {
    field: string;
    message: string;
}

export interface ValidationResult {
    ok: boolean;
    /** Typed values ready to store, keyed by setting name. */
    values: Record<string, unknown>;
    errors: FieldError[];
}

function validateOne(definition: SettingDefinition, raw: unknown): { value?: unknown; error?: string } {
    switch (definition.type) {
        case 'number': {
            const value = Number(raw);
            if (!Number.isFinite(value)) return { error: 'must be a number' };
            if (definition.min !== undefined && value < definition.min) {
                return { error: `must be at least ${definition.min}` };
            }
            if (definition.max !== undefined && value > definition.max) {
                return { error: `must be at most ${definition.max}` };
            }
            return { value: Math.floor(value) };
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return { value: raw };
            const text = String(raw).toLowerCase();
            if (['true', 'false', '1', '0'].includes(text)) return { value: text === 'true' || text === '1' };
            return { error: 'must be true or false' };
        }
        case 'enum':
            if (!definition.values?.includes(String(raw))) {
                return { error: `must be one of: ${definition.values?.join(', ')}` };
            }
            return { value: String(raw) };
        case 'cron':
            if (!isValidCron(String(raw))) {
                return { error: 'must be a five-field cron expression, e.g. "0 2,14 * * *"' };
            }
            return { value: String(raw) };
        case 'json-array': {
            if (typeof raw === 'object' && raw !== null) return { value: raw };
            try {
                return { value: JSON.parse(String(raw)) };
            } catch {
                return { error: 'must be valid JSON' };
            }
        }
        default: {
            const value = String(raw);
            if (definition.check) {
                const message = definition.check(value);
                if (message) return { error: message };
            }
            return { value };
        }
    }
}

/**
 * Validate a partial update. Every field is checked and every failure is
 * reported, rather than rejecting on the first one — a form with three bad
 * values should say so once, not three times in a row.
 */
export function validateSettings(patch: Record<string, unknown>): ValidationResult {
    const values: Record<string, unknown> = {};
    const errors: FieldError[] = [];

    for (const [key, raw] of Object.entries(patch)) {
        if (raw === undefined) continue;

        const definition = BY_KEY.get(key);
        if (!definition) {
            errors.push({ field: key, message: 'is not a known setting' });
            continue;
        }

        const result = validateOne(definition, raw);
        if (result.error) {
            errors.push({ field: key, message: `${definition.description}: ${result.error}` });
        } else {
            values[key] = result.value;
        }
    }

    return { ok: errors.length === 0, values, errors };
}

/** A single sentence naming every problem, for clients that show one message. */
export function summariseErrors(errors: FieldError[]): string {
    return errors.map(e => `${e.field} ${e.message}`).join('; ');
}
