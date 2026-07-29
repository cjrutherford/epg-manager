import { buildEpgSourceKey, getBuiltInGuideSources, getFeaturedIptvOrgSource, parseIptvOrgSitesMarkdown, rankEpgSources } from '../epg-sources';

describe('epg source helpers', () => {
  it('builds stable source keys from provider and site', () => {
    expect(buildEpgSourceKey('iptv-org', 'TVPassport.com')).toBe('iptv-org:tvpassport.com');
    expect(buildEpgSourceKey('iptv org', 'epgshare01.online')).toBe('iptv-org:epgshare01.online');
  });

  it('parses iptv-org SITES markdown into grab-capable source summaries', () => {
    const markdown = [
      '# Sites',
      'Site Channels Status Notes',
      '[tvpassport.com](sites/tvpassport.com) 19287',
      '[orangetv.orange.es](sites/orangetv.orange.es) 273 https://github.com/iptv-org/epg/issues/3099',
      '[bad](sites/bad) not-a-number'
    ].join('\n');

    expect(parseIptvOrgSitesMarkdown(markdown)).toEqual([
      {
        key: 'iptv-org:tvpassport.com',
        provider: 'iptv-org',
        site: 'tvpassport.com',
        label: 'tvpassport.com',
        channelCountEstimate: 19287,
        notes: ''
      },
      {
        key: 'iptv-org:orangetv.orange.es',
        provider: 'iptv-org',
        site: 'orangetv.orange.es',
        label: 'orangetv.orange.es',
        channelCountEstimate: 273,
        notes: 'https://github.com/iptv-org/epg/issues/3099'
      }
    ]);
  });

  it('parses current iptv-org SITES html table rows', () => {
    const markdown = [
      '<table>',
      '<tr><td><a href="sites/epgshare01.online">epgshare01.online</a></td><td align="right">20706</td><td align="center">🟢</td><td></td></tr>',
      '<tr><td><a href="sites/tvprofil.com">tvprofil.com</a></td><td align="right">8865</td><td align="center">🔴</td><td>https://github.com/iptv-org/epg/issues/3032</td></tr>',
      '</table>'
    ].join('\n');

    expect(parseIptvOrgSitesMarkdown(markdown)).toEqual([
      {
        key: 'iptv-org:epgshare01.online',
        provider: 'iptv-org',
        site: 'epgshare01.online',
        label: 'epgshare01.online',
        channelCountEstimate: 20706,
        notes: ''
      },
      {
        key: 'iptv-org:tvprofil.com',
        provider: 'iptv-org',
        site: 'tvprofil.com',
        label: 'tvprofil.com',
        channelCountEstimate: 8865,
        notes: 'https://github.com/iptv-org/epg/issues/3032'
      }
    ]);
  });

  it('marks epgshare01.online as the selected featured global provider', () => {
    expect(getFeaturedIptvOrgSource('epgshare01.online')).toEqual({
      label: 'EPGShare 01',
      priority: 100,
      notes: 'Featured global grab-capable source'
    });
  });

  it('defines EPGShare 01 as an external direct guide provider', () => {
    expect(getBuiltInGuideSources()).toEqual([
      {
        key: 'epgshare01:direct',
        provider: 'epgshare01',
        site: 'epgshare01.online',
        label: 'EPGShare 01 Direct',
        priority: 90,
        notes: 'External XMLTV guide feeds used for additional matching and guide data',
        urls: [
          'https://epgshare01.online/epgshare01/epg_ripper_US1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_CA1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_PLUTO1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_ROKU1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_SAMSUNG1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_PLEX1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_TUBI1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_DISTROTV1.xml.gz',
          'https://epgshare01.online/epgshare01/epg_ripper_STIRR1.xml.gz'
        ]
      }
    ]);
  });

  it('ranks sources by imported rows and upstream channel estimates', () => {
    const ranked = rankEpgSources([
      { key: 'small', importedRows: 50, channelCountEstimate: 100, priority: 0 },
      { key: 'large-upstream', importedRows: 10, channelCountEstimate: 20000, priority: 0 },
      { key: 'large-imported', importedRows: 500, channelCountEstimate: 500, priority: 0 },
      { key: 'featured', importedRows: 50, channelCountEstimate: 100, priority: 100 }
    ]);

    expect(ranked.map(source => source.key)).toEqual(['featured', 'large-imported', 'large-upstream', 'small']);
  });
});
