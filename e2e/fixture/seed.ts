/**
 * The seeded database every end-to-end test runs against.
 *
 * The existing suite assumed a server was already running with data in it, so
 * it failed on a clean checkout and passed or failed depending on whose machine
 * it was. A test that needs data it did not create is not a test, it is a
 * question about the local environment.
 *
 * The schema comes from the application's own `initDb`, so this cannot drift
 * from production. Only the rows are ours, and they are fixed: every count and
 * name below is something a spec is allowed to assert on exactly.
 */

import fs from 'fs';
import path from 'path';
// DB_DIR is read when this module loads, so the caller must set it before
// importing — see seed-cli.ts, which is why the seed runs as its own process.
import { db, initDb } from '../../src/db';

/** Everything a spec may rely on. Change these and the specs change with them. */
export const FIXTURE = {
    /** Channels the playlist import produced. */
    channelCount: 12,
    /** Of those, how many are matched to guide data. */
    matchedCount: 8,
    /** How many are disabled, to exercise the status filter. */
    disabledCount: 2,
    /** Programmes seeded across the matched channels. */
    programmeCount: 96,
    /** Sources this seed writes. */
    seededSourceCount: 3,
    /**
     * Sources the API reports once the server has booted.
     *
     * One more than the seed writes: the server migrates `playlist_urls` into
     * the registry on startup, which is real behaviour a fixture should show
     * rather than hide.
     */
    sourceCount: 4,
    /** A channel that is always present, matched, and first alphabetically. */
    firstChannelName: 'AAA Test Network',
    /** A channel deliberately left unmatched, for the unmatched filter. */
    unmatchedChannelName: 'Zeta Unmatched Stream',
    /** A programme title repeated across days, for series-rule tests. */
    seriesTitle: 'Fixture Serial',
    /** The admin password the fixture server runs with. */
    adminPassword: 'e2e-fixture-password'
} as const;

const CATEGORIES = ['News', 'Movies', 'Sports', 'Kids'];

function xmltvTime(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

/**
 * Build the fixture database at `dbDir`.
 *
 * Destructive by design: a fixture that accumulates state across runs is how a
 * suite starts passing for reasons nobody can name.
 */
export async function seedFixture(dbDir: string): Promise<void> {
    // The directory is removed by the caller before this process starts. It
    // cannot be done here: importing src/db opens the database file, so
    // deleting the directory underneath leaves the client on an unlinked inode
    // and every write fails with "disk I/O error".
    fs.mkdirSync(path.join(dbDir, 'recordings'), { recursive: true });

    if (path.resolve(process.env.DB_DIR || '') !== path.resolve(dbDir)) {
        throw new Error(
            `DB_DIR is ${process.env.DB_DIR}, not ${dbDir}. It must be set before this module is imported.`
        );
    }

    await initDb();

    // ── Channels ────────────────────────────────
    const channels: {
        id: string; name: string; matched: boolean; enabled: boolean; number: number; group: string;
    }[] = [];

    channels.push({
        id: 'aaa.test', name: FIXTURE.firstChannelName,
        matched: true, enabled: true, number: 100, group: 'News'
    });

    for (let i = 1; i <= 10; i++) {
        channels.push({
            id: `fixture-${i}.test`,
            name: `Fixture Channel ${String(i).padStart(2, '0')}`,
            matched: i <= 7,
            enabled: i > 8 ? false : true,
            number: 100 + i,
            group: CATEGORIES[i % CATEGORIES.length]
        });
    }

    channels.push({
        id: 'zzz.test', name: FIXTURE.unmatchedChannelName,
        matched: false, enabled: true, number: 199, group: 'Movies'
    });

    for (const channel of channels) {
        await db.execute({
            sql: `INSERT INTO channels (id, name, url, tvg_id, tvg_logo, group_title,
                                        channel_number, enabled, matched_epg_id, match_type, source_url)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                channel.id,
                channel.name,
                `http://fixture.invalid/${channel.id}.m3u8`,
                channel.id,
                `http://fixture.invalid/${channel.id}.png`,
                channel.group,
                channel.number,
                channel.enabled ? 1 : 0,
                channel.matched ? channel.id : null,
                channel.matched ? 'Exact' : null,
                'http://fixture.invalid/playlist.m3u'
            ]
        });
    }

    // ── Guide data ──────────────────────────────
    // Anchored to the top of the current hour so "now" always falls inside the
    // window, without the times being random.
    const base = new Date();
    base.setUTCMinutes(0, 0, 0);

    const matched = channels.filter(c => c.matched);
    let programmes = 0;

    for (const channel of matched) {
        await db.execute({
            sql: `INSERT INTO epg_channels (id, display_name, icon, source) VALUES (?, ?, ?, ?)`,
            args: [channel.id, channel.name, `http://fixture.invalid/${channel.id}.png`, 'fixture']
        });

        for (let slot = -1; slot < 11; slot++) {
            const start = new Date(base.getTime() + slot * 60 * 60 * 1000);
            const stop = new Date(start.getTime() + 60 * 60 * 1000);
            // Every channel carries the series title, so a series rule has
            // something to find on any of them.
            const title = slot % 4 === 0 ? FIXTURE.seriesTitle : `Programme ${slot + 1}`;

            await db.execute({
                sql: `INSERT INTO epg_programs (channel_id, source, start, stop, title, desc,
                                                sub_title, episode_num, category)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    channel.id, 'fixture', xmltvTime(start), xmltvTime(stop), title,
                    `Fixture programme for ${channel.name}.`,
                    `Episode ${slot + 2}`, `S01E${String(slot + 2).padStart(2, '0')}`,
                    channel.group
                ]
            });
            programmes++;
        }
    }

    // ── Sources ─────────────────────────────────
    // The url lives in config_json, matching how the registry writes it.
    const sources = [
        ['fixture:playlist', 'm3u', 'Fixture Playlist', 'channels', 'http://fixture.invalid/playlist.m3u'],
        ['fixture:guide', 'xmltv', 'Fixture Guide', 'guide', 'http://fixture.invalid/guide.xml'],
        ['fixture:extra', 'xmltv', 'Fixture Spare Guide', 'guide', 'http://fixture.invalid/spare.xml']
    ];
    for (const [key, kind, label, provides, url] of sources) {
        await db.execute({
            sql: `INSERT INTO sources (key, provider, site, label, kind, provides, config_json,
                                       enabled, priority, imported_rows, last_sync_at, last_sync_status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 1, 50, ?, ?, 'success')`,
            args: [
                key, 'fixture', key.split(':')[1], label, kind, provides,
                JSON.stringify({ id: key, kind, label, provides: [provides], fetch: { url } }),
                provides === 'channels' ? 12 : 96, Date.now()
            ]
        });
    }

    // ── Settings ────────────────────────────────
    for (const [key, value] of [
        ['playlist_urls', JSON.stringify(['http://fixture.invalid/playlist.m3u'])],
        ['epg_days', '2'],
        ['preferred_lang', 'en'],
        ['channel_numbering_mode', 'list'],
        ['metadata_enrichment_enabled', 'false']
    ]) {
        await db.execute({
            sql: `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
            args: [key, value]
        });
    }

    // ── Sanity: the fixture must match what it promises ──
    const assertCount = async (sql: string, expected: number, what: string) => {
        const actual = Number((await db.execute(sql)).rows[0].c);
        if (actual !== expected) {
            throw new Error(`Fixture is inconsistent: ${what} is ${actual}, FIXTURE says ${expected}`);
        }
    };

    await assertCount('SELECT COUNT(*) c FROM channels', FIXTURE.channelCount, 'channelCount');
    await assertCount('SELECT COUNT(*) c FROM channels WHERE matched_epg_id IS NOT NULL', FIXTURE.matchedCount, 'matchedCount');
    await assertCount('SELECT COUNT(*) c FROM channels WHERE enabled = 0', FIXTURE.disabledCount, 'disabledCount');
    await assertCount('SELECT COUNT(*) c FROM epg_programs', FIXTURE.programmeCount, 'programmeCount');
    await assertCount('SELECT COUNT(*) c FROM sources', FIXTURE.seededSourceCount, 'seededSourceCount');

    if (programmes !== FIXTURE.programmeCount) {
        throw new Error(`Seeded ${programmes} programmes but FIXTURE says ${FIXTURE.programmeCount}`);
    }
}
