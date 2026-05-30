export interface MemoryUsageLike {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers?: number;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMemorySnapshot(
  label: string,
  usage: MemoryUsageLike = process.memoryUsage(),
  extras: Record<string, string | number | boolean | null | undefined> = {}
): string {
  const base = [
    `[Memory] ${label}`,
    `rss=${formatBytes(usage.rss)}`,
    `heapUsed=${formatBytes(usage.heapUsed)}`,
    `heapTotal=${formatBytes(usage.heapTotal)}`,
    `external=${formatBytes(usage.external)}`
  ];

  const extraParts = Object.entries(extras)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);

  return [...base, ...extraParts].join(' | ');
}
