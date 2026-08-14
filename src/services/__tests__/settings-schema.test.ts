import {
    applyDefaults,
    getSettingDefinition,
    isKnownSetting,
    parseSetting,
    serializeSetting,
    SETTING_DEFINITIONS,
    summariseErrors,
    validateSettings
} from '../settings-schema';

describe('the schema itself', () => {
    it('defines every setting exactly once', () => {
        const keys = SETTING_DEFINITIONS.map(d => d.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('gives every setting a default and a description', () => {
        for (const definition of SETTING_DEFINITIONS) {
            expect(definition.default).toBeDefined();
            expect(definition.description.length).toBeGreaterThan(3);
        }
    });

    it('gives every enum its allowed values, and a default among them', () => {
        for (const definition of SETTING_DEFINITIONS.filter(d => d.type === 'enum')) {
            expect(definition.values && definition.values.length).toBeGreaterThan(1);
            expect(definition.values).toContain(definition.default as string);
        }
    });

    it("every default is a value the schema would itself accept", () => {
        for (const definition of SETTING_DEFINITIONS) {
            const result = validateSettings({ [definition.key]: definition.default });
            expect(result.errors).toEqual([]);
        }
    });
});

describe('applyDefaults', () => {
    it('produces one shape whether or not any rows exist', () => {
        const empty = applyDefaults({});
        const keys = SETTING_DEFINITIONS.map(d => d.key);
        expect(Object.keys(empty).sort()).toEqual([...keys].sort());
    });

    it('applies the defaults the two endpoints used to disagree about', () => {
        const config = applyDefaults({});
        // /api/settings defaulted this one; /api/config did not.
        expect(config.metadata_enrichment_enabled).toBe(true);
        // /api/config parsed this one into an array; /api/settings did not.
        expect(config.playlist_urls).toEqual([]);
        expect(config.channel_numbering_mode).toBe('list');
    });

    it('reads stored values over defaults', () => {
        const config = applyDefaults({
            epg_days: '7',
            metadata_enrichment_enabled: 'false',
            playlist_urls: '["http://a.m3u","http://b.m3u"]'
        });
        expect(config.epg_days).toBe(7);
        expect(config.metadata_enrichment_enabled).toBe(false);
        expect(config.playlist_urls).toEqual(['http://a.m3u', 'http://b.m3u']);
    });

    it('types values rather than returning the raw strings', () => {
        const config = applyDefaults({ epg_days: '5', dvr_padding_end_seconds: '180' });
        expect(typeof config.epg_days).toBe('number');
        expect(typeof config.dvr_padding_end_seconds).toBe('number');
        expect(typeof config.metadata_enrichment_enabled).toBe('boolean');
    });

    it('falls back when a stored value is unreadable', () => {
        const config = applyDefaults({
            epg_days: 'lots',
            playlist_urls: 'not json',
            sync_cron: 'every tuesday',
            channel_numbering_mode: 'sideways'
        });
        expect(config.epg_days).toBe(2);
        expect(config.playlist_urls).toEqual([]);
        expect(config.sync_cron).toBe('0 2,14 * * *');
        expect(config.channel_numbering_mode).toBe('list');
    });

    it('treats an empty string as absent', () => {
        expect(applyDefaults({ epg_days: '' }).epg_days).toBe(2);
    });

    it('keeps rows the schema does not know about', () => {
        const config = applyDefaults({ some_legacy_key: 'value' });
        expect(config.some_legacy_key).toBe('value');
    });
});

describe('validateSettings', () => {
    it('accepts a valid patch and types it', () => {
        const result = validateSettings({ epg_days: '7', metadata_enrichment_enabled: 'false' });
        expect(result.ok).toBe(true);
        expect(result.values).toEqual({ epg_days: 7, metadata_enrichment_enabled: false });
    });

    it('rejects with a field-level message, not a generic failure', () => {
        const result = validateSettings({ epg_days: 99 });
        expect(result.ok).toBe(false);
        expect(result.errors).toEqual([
            { field: 'epg_days', message: 'Days of guide data to grab: must be at most 14' }
        ]);
    });

    it('reports every bad field at once', () => {
        const result = validateSettings({
            epg_days: 0,
            channel_numbering_mode: 'sideways',
            sync_cron: 'sometimes'
        });
        expect(result.errors).toHaveLength(3);
        expect(result.errors.map(e => e.field).sort()).toEqual(['channel_numbering_mode', 'epg_days', 'sync_cron']);
    });

    it('names an unknown setting rather than storing it', () => {
        const result = validateSettings({ delete_everything: 'yes' });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toEqual({ field: 'delete_everything', message: 'is not a known setting' });
        expect(result.values).toEqual({});
    });

    it('keeps the good fields when others fail, so nothing is half-applied by accident', () => {
        const result = validateSettings({ epg_days: 5, channel_numbering_mode: 'sideways' });
        expect(result.ok).toBe(false);
        expect(result.values).toEqual({ epg_days: 5 });
    });

    it('ignores fields that were not sent', () => {
        expect(validateSettings({ epg_days: undefined }).values).toEqual({});
    });

    it('enforces enum membership', () => {
        expect(validateSettings({ dvr_retention_mode: 'age' }).ok).toBe(true);
        expect(validateSettings({ dvr_retention_mode: 'whenever' }).ok).toBe(false);
    });

    it('enforces cron syntax', () => {
        expect(validateSettings({ sync_cron: '30 3 * * *' }).ok).toBe(true);
        expect(validateSettings({ sync_cron: '30 3 * *' }).ok).toBe(false);
    });

    it('accepts booleans in the several forms a client might send', () => {
        for (const raw of [true, 'true', '1']) {
            expect(validateSettings({ metadata_enrichment_enabled: raw }).values.metadata_enrichment_enabled).toBe(true);
        }
        for (const raw of [false, 'false', '0']) {
            expect(validateSettings({ metadata_enrichment_enabled: raw }).values.metadata_enrichment_enabled).toBe(false);
        }
        expect(validateSettings({ metadata_enrichment_enabled: 'maybe' }).ok).toBe(false);
    });

    it('accepts JSON as an object or a string', () => {
        expect(validateSettings({ custom_channel_ranges: { News: 100 } }).ok).toBe(true);
        expect(validateSettings({ custom_channel_ranges: '{"News":100}' }).ok).toBe(true);
        expect(validateSettings({ custom_channel_ranges: '{oops' }).ok).toBe(false);
    });

    it('checks a language code looks like one', () => {
        expect(validateSettings({ preferred_lang: 'en' }).ok).toBe(true);
        expect(validateSettings({ preferred_lang: 'pt-BR' }).ok).toBe(true);
        expect(validateSettings({ preferred_lang: 'English please' }).ok).toBe(false);
        // The selector offers a blank "no preference" option.
        expect(validateSettings({ preferred_lang: '' }).ok).toBe(true);
    });
});

describe('serializeSetting', () => {
    const def = (key: string) => getSettingDefinition(key)!;

    it('round-trips through storage', () => {
        for (const [key, value] of [
            ['epg_days', 7],
            ['metadata_enrichment_enabled', false],
            ['sync_cron', '30 3 * * *'],
            ['channel_numbering_mode', 'auto-group'],
            ['playlist_urls', ['http://a.m3u']]
        ] as [string, unknown][]) {
            const stored = serializeSetting(def(key), value);
            expect(typeof stored).toBe('string');
            expect(parseSetting(def(key), stored)).toEqual(value);
        }
    });

    it('writes booleans the way the database already holds them', () => {
        expect(serializeSetting(def('metadata_enrichment_enabled'), true)).toBe('true');
        expect(serializeSetting(def('metadata_enrichment_enabled'), false)).toBe('false');
    });
});

describe('isKnownSetting', () => {
    it('knows the schema', () => {
        expect(isKnownSetting('epg_days')).toBe(true);
        expect(isKnownSetting('epg_dayz')).toBe(false);
    });
});

describe('summariseErrors', () => {
    it('names each field', () => {
        const summary = summariseErrors([
            { field: 'epg_days', message: 'must be at most 14' },
            { field: 'sync_cron', message: 'must be a cron expression' }
        ]);
        expect(summary).toBe('epg_days must be at most 14; sync_cron must be a cron expression');
    });
});
