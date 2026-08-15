/**
 * The point of re-scoping S16c: an existing adapter should consume a local file
 * with no adapter-side change at all.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// A temp directory stands in for the data directory: the transport confines
// reads to DB_DIR, so the test has to control where that points.
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'local-transport-'));
jest.mock('../../../db', () => ({
    DB_DIR,
    db: { execute: jest.fn().mockResolvedValue({ rows: [] }) }
}));

import { fetchSource } from '../fetcher';
import { parseM3UText } from '../m3u-stream';

const fixture = path.join(DB_DIR, 'local-transport-fixture.m3u');

const PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="one.us" tvg-logo="http://logo/1.png" group-title="News",Channel One
http://stream/one.m3u8
#EXTINF:-1 tvg-id="two.us" group-title="Movies",Channel Two
http://stream/two.m3u8
`;

beforeAll(() => {
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(fixture, PLAYLIST);
});

afterAll(() => {
    fs.rmSync(DB_DIR, { recursive: true, force: true });
});

it('reads a local playlist through the same fetch layer as an http one', async () => {
    const result = await fetchSource(fixture, {});
    expect(result.notModified).toBe(false);
    expect(String(result.body)).toContain('Channel One');
});

it('parses into channels with the unchanged m3u parser', async () => {
    const result = await fetchSource(fixture, {});
    const channels = [];
    for await (const channel of parseM3UText(String(result.body))) channels.push(channel);

    expect(channels.map(c => c.name)).toEqual(['Channel One', 'Channel Two']);
    expect(channels[0].tvgId).toBe('one.us');
    expect(channels[0].tvgLogo).toBe('http://logo/1.png');
    expect(channels[0].groupTitle).toBe('News');
    expect(channels[0].url).toBe('http://stream/one.m3u8');
});

it('reports an unchanged file as not modified, the local equivalent of a 304', async () => {
    const first = await fetchSource(fixture, {});
    const second = await fetchSource(fixture, { lastModified: first.lastModified as string });
    expect(second.notModified).toBe(true);
    expect(second.bytes).toBe(0);
});

it('refuses a path outside the data directory', async () => {
    await expect(fetchSource('/etc/passwd', {})).rejects.toThrow(/must live inside/);
});

it('names a missing file rather than failing obscurely', async () => {
    await expect(fetchSource(path.join(DB_DIR, 'absent.m3u'), {})).rejects.toThrow(/No such file/);
});
