import { getAdapter, registeredKinds } from '../adapter';
import { registerBuiltInAdapters } from '../index';
import { isLocalFilesUrl, parsePlaylist, toChannelRow } from '../adapters/m3u';
import { findArchiveRoot } from '../adapters/bundle';
import { siteFromDescriptor } from '../adapters/scraper-repo';
import type { SourceDescriptor } from '../descriptor';

describe('adapter registry', () => {
  beforeAll(() => registerBuiltInAdapters());

  it('registers the three ported kinds', () => {
    expect(registeredKinds()).toEqual(['bundle', 'm3u', 'scraper-repo', 'xmltv']);
  });

  it('hands back an adapter by kind, and null for an unknown one', () => {
    expect(getAdapter('m3u')?.kind).toBe('m3u');
    expect(getAdapter('bundle')?.kind).toBe('bundle');
    expect(getAdapter('scraper-repo')?.kind).toBe('scraper-repo');
    expect(getAdapter('xmltv')?.kind).toBe('xmltv');
    expect(getAdapter('xtream')).toBeNull();
  });

  it('registering twice does not duplicate', () => {
    registerBuiltInAdapters();
    expect(registeredKinds()).toHaveLength(4);
  });

  it('each adapter declares the capabilities it implements', () => {
    expect(typeof getAdapter('m3u')?.fetchLineup).toBe('function');
    expect(typeof getAdapter('bundle')?.fetchLineup).toBe('function');
    expect(typeof getAdapter('scraper-repo')?.syncCatalog).toBe('function');
    expect(typeof getAdapter('scraper-repo')?.fetchGuide).toBe('function');
  });
});

describe('m3u parsing', () => {
  const PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://logo/bbc1.png" group-title="UK",BBC One
http://stream/bbc1
#EXTINF:-1 tvg-id="" tvg-logo="" group-title="UK",Channel With No Id
http://stream/noid
`;

  it('maps a playlist entry onto the common channel shape', () => {
    const rows = parsePlaylist(PLAYLIST);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'BBC One',
      url: 'http://stream/bbc1',
      tvgId: 'bbc1.uk',
      tvgLogo: 'http://logo/bbc1.png',
      groupTitle: 'UK',
      lang: undefined
    });
  });

  it('drops entries with no stream url', () => {
    const rows = parsePlaylist(`#EXTM3U\n#EXTINF:-1,No Stream\n`);
    expect(rows).toEqual([]);
  });

  it('falls back to a placeholder name rather than dropping the channel', () => {
    expect(toChannelRow({ url: 'http://x', tvg: {}, group: {} }).name).toBe('Unknown Channel');
  });

  it('tolerates an empty playlist', () => {
    expect(parsePlaylist('#EXTM3U\n')).toEqual([]);
  });

  it('recognises local data-directory urls', () => {
    expect(isLocalFilesUrl('/files/iptv-org-playlists/uk.m3u')).toBe(true);
    expect(isLocalFilesUrl('https://example.com/uk.m3u')).toBe(false);
  });
});

describe('bundle archive handling', () => {
  it('unwraps the single root directory github archives use', () => {
    expect(findArchiveRoot(['iptv-master/countries/uk.m3u', 'iptv-master/index.m3u'])).toBe('iptv-master');
  });

  it('leaves a flat archive alone', () => {
    expect(findArchiveRoot(['uk.m3u', 'us.m3u'])).toBeNull();
  });
});

describe('scraper-repo descriptor handling', () => {
  const d = (id: string): SourceDescriptor => ({
    id, kind: 'scraper-repo', label: id, provides: ['guide'],
    enabled: true, priority: 0, fetch: {}
  });

  it('derives the site from a registry key', () => {
    expect(siteFromDescriptor(d('iptv-org:tvguide.co.uk'))).toBe('tvguide.co.uk');
  });

  it('uses a bare id as the site when there is no prefix', () => {
    expect(siteFromDescriptor(d('tvguide.co.uk'))).toBe('tvguide.co.uk');
  });
});
