export interface ExistingChannelRow {
  id: string;
  name: string;
  url: string;
  enabled: number;
  matched_epg_id: string | null;
  match_type: string | null;
  channel_number: number | null;
  source_url: string | null;
  tvg_id: string | null;
}

export interface PlaylistItemInput {
  name: string;
  url: string;
  tvgId: string;
  tvgLogo: string;
  groupTitle: string;
}

export interface PlaylistChannelRow {
  id: string;
  name: string;
  tvg_id: string;
  tvg_logo: string;
  group_title: string;
  url: string;
  source_url: string;
  channel_number: number;
  enabled: number;
  matched_epg_id: string | null;
  match_type: string | null;
}

export interface PlaylistImportIndexes {
  tvgIdMap: Map<string, ExistingChannelRow>;
  nameUrlMap: Map<string, ExistingChannelRow>;
  remainingIds: Set<string>;
  usedIds: Set<string>;
}

export function normalizePlaylistIdentityKey(name: string, url: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}_${url}`;
}

function slugifyChannelId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return slug || 'channel';
}

export function buildPlaylistImportIndexes(
  existingRows: ExistingChannelRow[],
  sourceUrl: string
): PlaylistImportIndexes {
  const tvgIdMap = new Map<string, ExistingChannelRow>();
  const nameUrlMap = new Map<string, ExistingChannelRow>();
  const remainingIds = new Set<string>();

  for (const row of existingRows) {
    if (row.tvg_id) {
      tvgIdMap.set(String(row.tvg_id), row);
    }

    nameUrlMap.set(normalizePlaylistIdentityKey(String(row.name), String(row.url)), row);

    if (row.source_url !== sourceUrl) {
      remainingIds.add(String(row.id).toLowerCase());
    }
  }

  return {
    tvgIdMap,
    nameUrlMap,
    remainingIds,
    usedIds: new Set<string>()
  };
}

function pickBaseChannelId(item: PlaylistItemInput, existingChannel: ExistingChannelRow | null): string {
  if (item.tvgId) {
    return item.tvgId;
  }

  if (existingChannel) {
    return existingChannel.id;
  }

  return slugifyChannelId(item.name || 'channel');
}

function preserveChannelState(existingChannel: ExistingChannelRow | null, fallbackNumber: number) {
  return {
    enabled: existingChannel ? existingChannel.enabled : 1,
    matched_epg_id: existingChannel ? existingChannel.matched_epg_id : null,
    match_type: existingChannel ? existingChannel.match_type : null,
    channel_number: existingChannel && existingChannel.channel_number ? existingChannel.channel_number : fallbackNumber
  };
}

export function createPlaylistChannelRecord(
  item: PlaylistItemInput,
  indexes: PlaylistImportIndexes,
  sourceUrl: string,
  fallbackNumber: number
): { row: PlaylistChannelRow; existingChannel: ExistingChannelRow | null } {
  let existingChannel: ExistingChannelRow | null = null;

  if (item.tvgId && indexes.tvgIdMap.has(item.tvgId)) {
    existingChannel = indexes.tvgIdMap.get(item.tvgId) || null;
  } else {
    const key = normalizePlaylistIdentityKey(item.name, item.url);
    existingChannel = indexes.nameUrlMap.get(key) || null;
  }

  const baseId = pickBaseChannelId(item, existingChannel);
  let finalId = baseId;
  let suffix = 1;

  while (indexes.usedIds.has(finalId.toLowerCase()) || indexes.remainingIds.has(finalId.toLowerCase())) {
    finalId = `${baseId}_${suffix}`;
    suffix++;
  }

  indexes.usedIds.add(finalId.toLowerCase());

  const preserved = preserveChannelState(existingChannel, fallbackNumber);

  return {
    existingChannel,
    row: {
      id: finalId,
      name: item.name || 'Unknown Channel',
      tvg_id: item.tvgId || '',
      tvg_logo: item.tvgLogo || '',
      group_title: item.groupTitle || '',
      url: item.url,
      source_url: sourceUrl,
      channel_number: preserved.channel_number,
      enabled: preserved.enabled,
      matched_epg_id: preserved.matched_epg_id,
      match_type: preserved.match_type
    }
  };
}
