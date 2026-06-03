import { dedupeChannelsForDisplay } from '../channel-dedup';

describe('channel display deduplication', () => {
  it('keeps the first channel for the same tvg identity', () => {
    const rows = dedupeChannelsForDisplay([
      { id: 'a', name: 'News HD', url: 'http://a', tvg_id: 'news.us', effective_epg_id: 'news.us', channel_number: 10 },
      { id: 'b', name: 'News HD Backup', url: 'http://b', tvg_id: 'news.us', effective_epg_id: 'news.us', channel_number: 11 },
    ]);

    expect(rows.map(row => row.id)).toEqual(['a']);
  });

  it('falls back to normalized name and stream url when no tvg identity exists', () => {
    const rows = dedupeChannelsForDisplay([
      { id: 'a', name: 'Movie Channel HD', url: 'http://movie', channel_number: 20 },
      { id: 'b', name: 'Movie Channel HD', url: 'http://movie', channel_number: 21 },
      { id: 'c', name: 'Movie Channel HD', url: 'http://backup', channel_number: 22 },
    ]);

    expect(rows.map(row => row.id)).toEqual(['a', 'c']);
  });
});
