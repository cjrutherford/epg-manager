import { parse } from 'iptv-playlist-parser';
import {
  iterateLines,
  parseExtinfAttributes,
  parseM3ULines,
  parseM3UText,
  splitExtinf
} from '../m3u-stream';
import { toChannelRow } from '../adapters/m3u';
import type { ChannelRow } from '../adapter';

async function collect(iterable: AsyncIterable<ChannelRow>): Promise<ChannelRow[]> {
  const rows: ChannelRow[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

describe('splitExtinf', () => {
  it('splits on the comma that ends the attributes', () => {
    expect(splitExtinf('-1 tvg-id="a" group-title="UK",BBC One'))
      .toEqual({ attributes: '-1 tvg-id="a" group-title="UK"', name: 'BBC One' });
  });

  it('ignores commas inside a quoted attribute value', () => {
    expect(splitExtinf('-1 group-title="News, Sport",Sky News'))
      .toEqual({ attributes: '-1 group-title="News, Sport"', name: 'Sky News' });
  });

  it('keeps commas that belong to the channel name', () => {
    expect(splitExtinf('-1 tvg-id="x",Film4 +1, HD').name).toBe('Film4 +1, HD');
  });

  it('handles an entry with no name', () => {
    expect(splitExtinf('-1 tvg-id="x"')).toEqual({ attributes: '-1 tvg-id="x"', name: '' });
  });
});

describe('parseExtinfAttributes', () => {
  it('reads the attributes that matter', () => {
    expect(parseExtinfAttributes('-1 tvg-id="bbc1.uk" tvg-logo="http://l/1.png" group-title="UK"'))
      .toEqual({ 'tvg-id': 'bbc1.uk', 'tvg-logo': 'http://l/1.png', 'group-title': 'UK' });
  });

  it('is case-insensitive on keys and tolerates spacing', () => {
    expect(parseExtinfAttributes('-1 TVG-ID = "x"')).toEqual({ 'tvg-id': 'x' });
  });

  it('returns nothing for an attribute-free line', () => {
    expect(parseExtinfAttributes('-1')).toEqual({});
  });
});

describe('parseM3ULines', () => {
  it('yields a channel once its url arrives', async () => {
    const rows = await collect(parseM3UText(
      `#EXTM3U\n#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://l.png" group-title="UK",BBC One\nhttp://s/1\n`
    ));
    expect(rows).toEqual([{
      name: 'BBC One', url: 'http://s/1', tvgId: 'bbc1.uk',
      tvgLogo: 'http://l.png', groupTitle: 'UK', lang: undefined
    }]);
  });

  it('drops an entry with no url', async () => {
    expect(await collect(parseM3UText(`#EXTM3U\n#EXTINF:-1,No Stream\n`))).toEqual([]);
  });

  it('takes a group from #EXTGRP when the attribute is absent', async () => {
    const rows = await collect(parseM3UText(
      `#EXTINF:-1 tvg-id="a",A\n#EXTGRP:Sports\nhttp://s/a\n`
    ));
    expect(rows[0].groupTitle).toBe('Sports');
  });

  it('does not let #EXTGRP override an explicit group-title', async () => {
    const rows = await collect(parseM3UText(
      `#EXTINF:-1 group-title="UK",A\n#EXTGRP:Sports\nhttp://s/a\n`
    ));
    expect(rows[0].groupTitle).toBe('UK');
  });

  it('skips directives that are not stream urls', async () => {
    const rows = await collect(parseM3UText(
      `#EXTINF:-1,A\n#EXTVLCOPT:http-user-agent=Mozilla\nhttp://s/a\n`
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('http://s/a');
  });

  it('ignores a url with no preceding #EXTINF', async () => {
    expect(await collect(parseM3UText(`#EXTM3U\nhttp://orphan\n`))).toEqual([]);
  });

  it('falls back to tvg-name when the display name is empty', async () => {
    const rows = await collect(parseM3UText(`#EXTINF:-1 tvg-name="Fallback",\nhttp://s/a\n`));
    expect(rows[0].name).toBe('Fallback');
  });

  it('handles CRLF line endings', async () => {
    const rows = await collect(parseM3UText(`#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://s/a\r\n`));
    expect(rows[0]).toMatchObject({ name: 'A', url: 'http://s/a' });
  });
});

describe('iterateLines', () => {
  it('reassembles lines split across chunk boundaries', async () => {
    async function* chunks() {
      yield Buffer.from('#EXTINF:-1,A\nhttp://s/');
      yield Buffer.from('a\n#EXTINF:-1,B\nhttp://s/b');
    }
    const lines: string[] = [];
    for await (const line of iterateLines(chunks())) lines.push(line);
    expect(lines).toEqual(['#EXTINF:-1,A', 'http://s/a', '#EXTINF:-1,B', 'http://s/b']);
  });

  it('emits a trailing line with no newline', async () => {
    async function* chunks() { yield 'only line'; }
    const lines: string[] = [];
    for await (const line of iterateLines(chunks())) lines.push(line);
    expect(lines).toEqual(['only line']);
  });
});

/**
 * The streaming parser replaces a battle-tested library, so it has to agree
 * with it on realistic input before it is trusted with real playlists.
 */
describe('equivalence with iptv-playlist-parser', () => {
  const PLAYLIST = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://l/bbc1.png" group-title="UK",BBC One',
    'http://stream/bbc1',
    '#EXTINF:-1 tvg-id="sky.uk" tvg-logo="" group-title="News, Sport",Sky News',
    'http://stream/sky',
    '#EXTINF:-1 tvg-id="" tvg-logo="http://l/x.png" group-title="Movies",Film4 +1, HD',
    'http://stream/film4',
    '#EXTINF:-1 tvg-id="noattrs.uk",Plain Channel',
    'http://stream/plain',
    '#EXTINF:-1 tvg-id="unicode.uk" group-title="Übersicht",Kanal Ä',
    'http://stream/unicode',
    ''
  ].join('\n');

  it('produces the same channels as the library', async () => {
    const library = parse(PLAYLIST).items.map(toChannelRow).filter(row => !!row.url);
    const streamed = await collect(parseM3UText(PLAYLIST));

    expect(streamed).toHaveLength(library.length);
    for (let i = 0; i < library.length; i++) {
      expect({ index: i, ...streamed[i] }).toEqual({
        index: i,
        name: library[i].name,
        url: library[i].url,
        tvgId: library[i].tvgId,
        tvgLogo: library[i].tvgLogo,
        groupTitle: library[i].groupTitle,
        lang: streamed[i].lang
      });
    }
  });

  it('agrees on a generated playlist of a thousand channels', async () => {
    const lines = ['#EXTM3U'];
    for (let i = 1; i <= 1000; i++) {
      lines.push(`#EXTINF:-1 tvg-id="ch${i}.test" tvg-logo="http://l/${i}.png" group-title="G${i % 7}",Channel ${i}`);
      lines.push(`http://stream/live/${i}.m3u8`);
    }
    const text = lines.join('\n') + '\n';

    const library = parse(text).items.map(toChannelRow).filter(row => !!row.url);
    const streamed = await collect(parseM3UText(text));

    expect(streamed).toHaveLength(1000);
    expect(streamed.map(r => r.url)).toEqual(library.map(r => r.url));
    expect(streamed.map(r => r.name)).toEqual(library.map(r => r.name));
    expect(streamed.map(r => r.tvgId)).toEqual(library.map(r => r.tvgId));
    expect(streamed.map(r => r.groupTitle)).toEqual(library.map(r => r.groupTitle));
  });
});
