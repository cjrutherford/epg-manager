import * as fs from 'fs';
import * as path from 'path';
import { DB_DIR } from '../db';

export interface PlaylistMetadata {
  url: string;
  name: string;
  label: string;
  slug: string;
  category: string;
  sourceType: 'iptv-org' | 'remote' | 'custom';
  host: string;
  pathSummary: string;
  channelCountEstimate: number | null;
}

const playlistCountCache = new Map<string, { mtimeMs: number; count: number }>();

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'playlist';
}

function titleizeSlug(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function summarizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  if (pathname.length <= 36) return pathname;
  return `...${pathname.slice(-33)}`;
}

export function getPlaylistEstimate(localPath: string): number | null {
  try {
    const stats = fs.statSync(localPath);
    const cached = playlistCountCache.get(localPath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return cached.count;
    }

    const content = fs.readFileSync(localPath, 'utf8');
    let count = 0;
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith('#EXTINF')) count++;
    }

    playlistCountCache.set(localPath, { mtimeMs: stats.mtimeMs, count });
    return count;
  } catch {
    return null;
  }
}

function parseIptvOrgUrl(url: string): { category: string; slug: string; localPath: string } | null {
  const match = url.match(/^\/files\/iptv-org-playlists\/([^/]+)\/([^/]+)\.m3u$/i);
  if (!match) return null;

  const category = match[1].toLowerCase();
  const slug = match[2];
  const localPath = path.join(DB_DIR, 'iptv-org-playlists', category, `${slug}.m3u`);

  return { category, slug, localPath };
}

export function describePlaylist(url: string, importedCount = 0): PlaylistMetadata & { importedCount: number; active?: boolean } {
  const iptvOrg = parseIptvOrgUrl(url);
  if (iptvOrg) {
    const label = titleizeSlug(iptvOrg.slug);
    return {
      url,
      name: `${label} (${iptvOrg.category})`,
      label,
      slug: slugify(iptvOrg.slug),
      category: iptvOrg.category,
      sourceType: 'iptv-org',
      host: 'iptv-org',
      pathSummary: `${iptvOrg.category}/${iptvOrg.slug}.m3u`,
      channelCountEstimate: getPlaylistEstimate(iptvOrg.localPath),
      importedCount
    };
  }

  // FAST Platform presets check (e.g. PlutoTV, SamsungTVPlus, Roku, Plex, PBS, Stirr)
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('plutotv')) {
    return { url, name: 'Pluto TV (All Channels)', label: 'Pluto TV', slug: 'pluto-tv', category: 'fast', sourceType: 'remote', host: 'i.mjh.nz', pathSummary: 'PlutoTV/all.m3u8', channelCountEstimate: 350, importedCount };
  }
  if (lowerUrl.includes('samsungtvplus')) {
    return { url, name: 'Samsung TV Plus (All Channels)', label: 'Samsung TV Plus', slug: 'samsung-tv-plus', category: 'fast', sourceType: 'remote', host: 'i.mjh.nz', pathSummary: 'SamsungTVPlus/all.m3u8', channelCountEstimate: 280, importedCount };
  }
  if (lowerUrl.includes('roku')) {
    return { url, name: 'Roku Channel (All Channels)', label: 'Roku Channel', slug: 'roku-channel', category: 'fast', sourceType: 'remote', host: 'i.mjh.nz', pathSummary: 'Roku/all.m3u8', channelCountEstimate: 300, importedCount };
  }
  if (lowerUrl.includes('/plex/') || lowerUrl.includes('plex.m3u')) {
    return { url, name: 'Plex TV (All Channels)', label: 'Plex TV', slug: 'plex-tv', category: 'fast', sourceType: 'remote', host: 'i.mjh.nz', pathSummary: 'Plex/all.m3u8', channelCountEstimate: 250, importedCount };
  }
  if (lowerUrl.includes('/pbs/')) {
    return { url, name: 'PBS Live (All Channels)', label: 'PBS Live', slug: 'pbs-live', category: 'fast', sourceType: 'remote', host: 'i.mjh.nz', pathSummary: 'PBS/all.m3u8', channelCountEstimate: 120, importedCount };
  }
  if (lowerUrl.includes('/stirr/')) {
    return { url, name: 'Stirr TV (All Channels)', label: 'Stirr TV', slug: 'stirr-tv', category: 'fast', sourceType: 'remote', host: 'i.mjh.nz', pathSummary: 'Stirr/all.m3u8', channelCountEstimate: 100, importedCount };
  }

  try {
    const parsed = new URL(url);
    const rawName = parsed.pathname.split('/').pop() || parsed.hostname;
    const label = rawName.replace(/\.m3u8?$/i, '') || parsed.hostname;
    return {
      url,
      name: rawName,
      label,
      slug: slugify(label),
      category: 'custom',
      sourceType: 'remote',
      host: parsed.hostname,
      pathSummary: summarizePath(parsed.pathname),
      channelCountEstimate: null,
      importedCount
    };
  } catch {
    return {
      url,
      name: url,
      label: url.length > 40 ? `${url.slice(0, 37)}...` : url,
      slug: slugify(url),
      category: 'custom',
      sourceType: 'custom',
      host: 'custom',
      pathSummary: summarizePath(url),
      channelCountEstimate: null,
      importedCount
    };
  }
}

export function clearPlaylistEstimateCache(): void {
  playlistCountCache.clear();
}
