export function filterNewQueueIds(ids: string[], seen: Set<string>): string[] {
  const fresh: string[] = [];

  for (const rawId of ids) {
    const id = rawId.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    fresh.push(id);
  }

  return fresh;
}

const LAST_RESORT_SITES = new Set(['epg.iptvx.one']);

export function getGrabBatchSizeForSite(site: string): number {
  return LAST_RESORT_SITES.has(site) ? 1 : 10;
}

export function prioritizeGrabSites<T extends string>(sites: T[]): T[] {
  return [...sites].sort((left, right) => {
    const leftPriority = LAST_RESORT_SITES.has(left) ? 1 : 0;
    const rightPriority = LAST_RESORT_SITES.has(right) ? 1 : 0;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });
}
