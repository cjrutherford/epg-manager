import { Readable } from 'stream';
import { parseIptvOrgChannelsXmlStream } from '../iptv-org-parser';

describe('parseIptvOrgChannelsXmlStream', () => {
  it('parses chunked channel XML rows without loading the full file first', async () => {
    const chunks = [
      '<channels><channel xmltv_id="one.us" lang="en" site="site-a"',
      ' site_id="a1">One</channel><channel xmltv_id="two.us" ',
      'lang="es" site="site-b" site_id="b2">Two</channel></channels>'
    ];

    const rows: any[] = [];
    const count = await parseIptvOrgChannelsXmlStream(Readable.from(chunks), async (row) => {
      rows.push(row);
    });

    expect(count).toBe(2);
    expect(rows).toEqual([
      { name: 'One', xmltv_id: 'one.us', lang: 'en', site: 'site-a', site_id: 'a1' },
      { name: 'Two', xmltv_id: 'two.us', lang: 'es', site: 'site-b', site_id: 'b2' }
    ]);
  });

  it('ignores channels missing required fields', async () => {
    const xml = '<channels><channel site="x">No Id</channel><channel xmltv_id="ok" site="s" site_id="1">Valid</channel></channels>';
    const rows: any[] = [];

    const count = await parseIptvOrgChannelsXmlStream(Readable.from([xml]), async (row) => {
      rows.push(row);
    });

    expect(count).toBe(1);
    expect(rows).toEqual([
      { name: 'Valid', xmltv_id: 'ok', lang: null, site: 's', site_id: '1' }
    ]);
  });
});
