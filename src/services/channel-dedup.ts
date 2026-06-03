export type DisplayChannelRow = Record<string, unknown> & {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  tvg_id?: unknown;
  effective_epg_id?: unknown;
};

function normalize(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeName(value: unknown): string {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

function identityKey(row: DisplayChannelRow): string {
  const tvgIdentity = normalize(row.effective_epg_id || row.tvg_id);
  if (tvgIdentity) return `tvg:${tvgIdentity}`;

  const name = normalizeName(row.name);
  const url = normalize(row.url);
  return `name-url:${name}:${url}`;
}

export function dedupeChannelsForDisplay<T extends DisplayChannelRow>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const row of rows) {
    const key = identityKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}
