import {
  buildPlaylistImportIndexes,
  createPlaylistChannelRecord,
  normalizePlaylistIdentityKey,
  type ExistingChannelRow,
  type PlaylistItemInput
} from '../services/playlist-import';

describe('playlist import helpers', () => {
  const sourceUrl = 'https://example.com/a.m3u';

  it('normalizes fallback identity keys by name and stream url', () => {
    expect(normalizePlaylistIdentityKey('Foo TV HD', 'http://stream')).toBe('footvhd_http://stream');
  });

  it('preserves existing channel state from matching tvg-id rows', () => {
    const existingRows: ExistingChannelRow[] = [{
      id: 'existing-1',
      name: 'Channel 1',
      url: 'http://stream1',
      enabled: 0,
      matched_epg_id: 'epg-1',
      match_type: 'Exact ID Match',
      channel_number: 777,
      source_url: 'https://example.com/other.m3u',
      tvg_id: 'chan1'
    }];

    const indexes = buildPlaylistImportIndexes(existingRows, sourceUrl);
    const item: PlaylistItemInput = {
      name: 'Channel 1',
      url: 'http://stream1',
      tvgId: 'chan1',
      tvgLogo: 'http://logo',
      groupTitle: 'News'
    };

    const record = createPlaylistChannelRecord(item, indexes, sourceUrl, 1);

    expect(record.row.id).toBe('chan1');
    expect(record.row.enabled).toBe(0);
    expect(record.row.matched_epg_id).toBe('epg-1');
    expect(record.row.match_type).toBe('Exact ID Match');
    expect(record.row.channel_number).toBe(777);
  });

  it('falls back to name and url identity when tvg-id is missing', () => {
    const existingRows: ExistingChannelRow[] = [{
      id: 'movie_channel',
      name: 'Movie Channel HD',
      url: 'http://movie-stream',
      enabled: 1,
      matched_epg_id: null,
      match_type: null,
      channel_number: 9,
      source_url: 'https://example.com/other.m3u',
      tvg_id: null
    }];

    const indexes = buildPlaylistImportIndexes(existingRows, sourceUrl);
    const item: PlaylistItemInput = {
      name: 'Movie Channel HD',
      url: 'http://movie-stream',
      tvgId: '',
      tvgLogo: '',
      groupTitle: 'Movies'
    };

    const record = createPlaylistChannelRecord(item, indexes, sourceUrl, 2);

    expect(record.row.id).toBe('movie_channel_1');
    expect(record.row.channel_number).toBe(9);
  });

  it('suffixes ids only on real collisions from other sources', () => {
    const existingRows: ExistingChannelRow[] = [{
      id: 'duplicate',
      name: 'Duplicate',
      url: 'http://other-stream',
      enabled: 1,
      matched_epg_id: null,
      match_type: null,
      channel_number: 1,
      source_url: 'https://example.com/other.m3u',
      tvg_id: null
    }];

    const indexes = buildPlaylistImportIndexes(existingRows, sourceUrl);

    const first = createPlaylistChannelRecord({
      name: 'Duplicate',
      url: 'http://stream-a',
      tvgId: '',
      tvgLogo: '',
      groupTitle: ''
    }, indexes, sourceUrl, 1);

    const second = createPlaylistChannelRecord({
      name: 'Duplicate',
      url: 'http://stream-b',
      tvgId: '',
      tvgLogo: '',
      groupTitle: ''
    }, indexes, sourceUrl, 2);

    expect(first.row.id).toBe('duplicate_1');
    expect(second.row.id).toBe('duplicate_2');
  });
});
