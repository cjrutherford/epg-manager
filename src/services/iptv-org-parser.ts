import sax from 'sax';
import { Readable } from 'stream';

export interface IptvOrgChannelRow {
  name: string;
  xmltv_id: string;
  lang: string | null;
  site: string | null;
  site_id: string | null;
}

export async function parseIptvOrgChannelsXmlStream(
  input: Readable,
  onRow: (row: IptvOrgChannelRow) => Promise<void> | void
): Promise<number> {
  const parser = sax.createStream(true, { trim: true, normalize: true });

  let currentChannel: Record<string, string> | null = null;
  let currentText = '';
  let count = 0;
  let chain = Promise.resolve();

  parser.on('opentag', (node) => {
    if (node.name === 'channel') {
      const attrs = node.attributes as Record<string, string>;
      currentChannel = { ...attrs };
      currentText = '';
    }
  });

  parser.on('text', (text: string) => {
    if (currentChannel) {
      currentText += text;
    }
  });

  parser.on('closetag', (tagName: string) => {
    if (tagName !== 'channel' || !currentChannel) {
      return;
    }

    const row: IptvOrgChannelRow = {
      name: currentText.trim(),
      xmltv_id: currentChannel.xmltv_id || '',
      lang: currentChannel.lang || null,
      site: currentChannel.site || null,
      site_id: currentChannel.site_id || null
    };

    currentChannel = null;
    currentText = '';

    if (!row.name || !row.xmltv_id) {
      return;
    }

    count++;
    chain = chain.then(() => onRow(row));
  });

  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => reject(error);

    input.on('error', onError);
    parser.on('error', onError);
    parser.on('end', () => {
      chain.then(() => resolve(count)).catch(reject);
    });

    input.pipe(parser);
  });
}
