import { Readable } from 'stream';
import { guideWindowDays, parseXmltv, parseXmltvTime } from '../adapters/xmltv';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="bbc1.uk">
    <display-name>BBC One</display-name>
    <icon src="http://logo/bbc1.png" />
  </channel>
  <channel id="itv.uk">
    <display-name>ITV</display-name>
  </channel>
  <programme start="20260814120000 +0000" stop="20260814130000 +0000" channel="bbc1.uk">
    <title>The News</title>
    <desc>Today's headlines</desc>
    <sub-title>Lunchtime</sub-title>
    <episode-num system="onscreen">S01E04</episode-num>
    <category>News</category>
    <category>Current Affairs</category>
    <rating><value>PG</value></rating>
    <icon src="http://img/news.png" />
  </programme>
  <programme start="20260814130000 +0000" stop="20260814140000 +0000" channel="itv.uk">
    <title>Afternoon Film</title>
  </programme>
</tv>`;

const feed = (xml = FEED) => Readable.from([xml]);

describe('parseXmltv', () => {
  it('reads channels with display names and icons', async () => {
    const { channels } = await parseXmltv(feed());
    expect(channels).toEqual([
      { id: 'bbc1.uk', displayName: 'BBC One', icon: 'http://logo/bbc1.png' },
      { id: 'itv.uk', displayName: 'ITV', icon: '' }
    ]);
  });

  it('reads a programme with every field populated', async () => {
    const { programmes } = await parseXmltv(feed());
    expect(programmes[0]).toEqual({
      channelId: 'bbc1.uk',
      start: '20260814120000 +0000',
      stop: '20260814130000 +0000',
      title: 'The News',
      desc: "Today's headlines",
      subTitle: 'Lunchtime',
      episodeNum: 'S01E04',
      category: 'News, Current Affairs',
      rating: 'PG',
      icon: 'http://img/news.png'
    });
  });

  it('keeps a programme that only has the required fields', async () => {
    const { programmes } = await parseXmltv(feed());
    expect(programmes[1].title).toBe('Afternoon Film');
    expect(programmes[1].desc).toBeUndefined();
  });

  it('does not confuse a programme icon with a channel icon', async () => {
    const { channels, programmes } = await parseXmltv(feed());
    expect(channels[0].icon).toBe('http://logo/bbc1.png');
    expect(programmes[0].icon).toBe('http://img/news.png');
  });

  it('drops programmes with no channel or start', async () => {
    const { programmes } = await parseXmltv(Readable.from([
      `<tv><programme stop="20260814130000 +0000"><title>Orphan</title></programme></tv>`
    ]));
    expect(programmes).toEqual([]);
  });

  it('honours the sample limit and reports truncation', async () => {
    const { programmes, truncated } = await parseXmltv(feed(), { limit: 1 });
    expect(programmes).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it('handles an empty feed without throwing', async () => {
    const { channels, programmes } = await parseXmltv(Readable.from(['<tv></tv>']));
    expect(channels).toEqual([]);
    expect(programmes).toEqual([]);
  });

  it('rejects malformed xml rather than returning half a feed', async () => {
    await expect(parseXmltv(Readable.from(['<tv><channel id="a"><oops></tv>'])))
      .rejects.toBeDefined();
  });
});

describe('parseXmltvTime', () => {
  it('parses the standard form with an offset', () => {
    expect(parseXmltvTime('20260814120000 +0000')).toBe(Date.parse('2026-08-14T12:00:00Z'));
  });

  it('applies a non-zero offset', () => {
    expect(parseXmltvTime('20260814120000 +0200')).toBe(Date.parse('2026-08-14T12:00:00+02:00'));
  });

  it('tolerates a missing seconds field', () => {
    expect(parseXmltvTime('202608141200')).toBe(Date.parse('2026-08-14T12:00:00Z'));
  });

  it('returns null for junk', () => {
    expect(parseXmltvTime('tomorrow')).toBeNull();
    expect(parseXmltvTime(undefined)).toBeNull();
  });
});

describe('guideWindowDays', () => {
  it('measures earliest start to latest stop', async () => {
    const { programmes } = await parseXmltv(feed());
    const days = guideWindowDays(programmes);
    expect(days).toBeCloseTo(2 / 24, 5);
  });

  it('returns null when nothing is parseable', () => {
    expect(guideWindowDays([])).toBeNull();
  });
});
