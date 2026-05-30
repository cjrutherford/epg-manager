import { formatBytes, formatMemorySnapshot } from '../memory';

describe('memory helpers', () => {
  it('formats bytes in megabytes with one decimal place', () => {
    expect(formatBytes(1572864)).toBe('1.5 MB');
  });

  it('formats a memory snapshot with stable keys and extras', () => {
    const line = formatMemorySnapshot('playlist import', {
      rss: 10485760,
      heapUsed: 5242880,
      heapTotal: 6291456,
      external: 1048576,
      arrayBuffers: 262144
    }, { imported: 42, source: 'demo' });

    expect(line).toContain('[Memory] playlist import');
    expect(line).toContain('rss=10.0 MB');
    expect(line).toContain('heapUsed=5.0 MB');
    expect(line).toContain('heapTotal=6.0 MB');
    expect(line).toContain('external=1.0 MB');
    expect(line).toContain('imported=42');
    expect(line).toContain('source=demo');
  });
});
