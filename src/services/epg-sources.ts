export interface EpgSourceSummary {
  key: string;
  provider?: string;
  site?: string;
  label?: string;
  channelCountEstimate?: number | null;
  importedRows?: number;
  priority?: number;
  notes?: string;
}

export interface FeaturedIptvOrgSource {
  label: string;
  priority: number;
  notes: string;
}

export interface BuiltInGuideSource {
  key: string;
  provider: string;
  site: string;
  label: string;
  priority: number;
  notes: string;
  urls: string[];
}

const FEATURED_IPTV_ORG_SOURCES: Record<string, FeaturedIptvOrgSource> = {
  'epgshare01.online': {
    label: 'EPGShare 01',
    priority: 100,
    notes: 'Featured global grab-capable source'
  },
  'pluto.tv': {
    label: 'Pluto TV',
    priority: 95,
    notes: 'Featured FAST channel guide source'
  },
  'samsung.com': {
    label: 'Samsung TV Plus',
    priority: 95,
    notes: 'Featured FAST channel guide source'
  },
  'therokuchannel.com': {
    label: 'Roku Channel',
    priority: 95,
    notes: 'Featured FAST channel guide source'
  },
  'plex.tv': {
    label: 'Plex TV',
    priority: 90,
    notes: 'Featured FAST channel guide source'
  },
  'tubitv.com': {
    label: 'Tubi TV',
    priority: 90,
    notes: 'Featured FAST channel guide source'
  },
  'distro.tv': {
    label: 'DistroTV',
    priority: 90,
    notes: 'Featured FAST channel guide source'
  },
  'i.mjh.nz': {
    label: 'MJH NZ (Pluto/Samsung)',
    priority: 95,
    notes: 'Featured Pluto & Samsung guide feed source'
  }
};

const EPGSHARE01_TAGS = ['US1', 'CA1', 'UK1', 'PLUTO1', 'ROKU1', 'SAMSUNG1', 'PLEX1', 'TUBI1', 'DISTROTV1', 'STIRR1'];

const BUILT_IN_GUIDE_SOURCES: BuiltInGuideSource[] = [
  {
    key: 'epgshare01:direct',
    provider: 'epgshare01',
    site: 'epgshare01.online',
    label: 'EPGShare 01 Direct',
    priority: 90,
    notes: 'External XMLTV guide feeds used for additional matching and guide data',
    urls: EPGSHARE01_TAGS.map(tag => `https://epgshare01.online/epgshare01/epg_ripper_${tag}.xml.gz`)
  }
];

function slugPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildEpgSourceKey(provider: string, site: string): string {
  return `${slugPart(provider)}:${slugPart(site)}`;
}

export function getFeaturedIptvOrgSource(site: string): FeaturedIptvOrgSource | null {
  return FEATURED_IPTV_ORG_SOURCES[site.trim().toLowerCase()] || null;
}

export function getBuiltInGuideSources(): BuiltInGuideSource[] {
  return BUILT_IN_GUIDE_SOURCES.map(source => ({
    ...source,
    urls: [...source.urls]
  }));
}

function cleanHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function parseIptvOrgSitesMarkdown(markdown: string): EpgSourceSummary[] {
  const sources: EpgSourceSummary[] = [];
  const markdownLinePattern = /^\[([^\]]+)\]\([^)]+\)\s+(\d+)(?:\s+(.*))?$/;
  const htmlRowPattern = /<tr><td><a href="sites\/([^"]+)">[^<]+<\/a><\/td><td[^>]*>(\d+)<\/td><td[^>]*>.*?<\/td><td>(.*?)<\/td><\/tr>/;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(markdownLinePattern) || trimmed.match(htmlRowPattern);
    if (!match) continue;

    const site = match[1].trim();
    const channelCountEstimate = Number(match[2]);
    if (!site || !Number.isFinite(channelCountEstimate)) continue;

    sources.push({
      key: buildEpgSourceKey('iptv-org', site),
      provider: 'iptv-org',
      site,
      label: site,
      channelCountEstimate,
      notes: cleanHtml(match[3] || '')
    });
  }

  return sources;
}

export function rankEpgSources<T extends EpgSourceSummary>(sources: T[]): T[] {
  return [...sources].sort((left, right) => {
    const leftValue = Number(left.priority || 0) * 1000000 + Number(left.importedRows || 0) * 100 + Number(left.channelCountEstimate || 0);
    const rightValue = Number(right.priority || 0) * 1000000 + Number(right.importedRows || 0) * 100 + Number(right.channelCountEstimate || 0);
    if (leftValue !== rightValue) return rightValue - leftValue;

    return left.key.localeCompare(right.key);
  });
}
