import { describePlaylist } from '../playlist-metadata';

describe('playlist metadata', () => {
  it('describes remote playlists with host and path summary', () => {
    const result = describePlaylist('https://example.com/live/us.m3u', 12);

    expect(result.sourceType).toBe('remote');
    expect(result.host).toBe('example.com');
    expect(result.importedCount).toBe(12);
    expect(result.pathSummary).toBe('/live/us.m3u');
  });

  it('describes iptv-org playlists with derived metadata', () => {
    const result = describePlaylist('/files/iptv-org-playlists/countries/us.m3u', 3);

    expect(result.sourceType).toBe('iptv-org');
    expect(result.category).toBe('countries');
    expect(result.label).toBe('Us');
    expect(result.pathSummary).toBe('countries/us.m3u');
  });
});
