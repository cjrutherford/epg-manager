import { findOrphanStreamDirs, selectStreamToEvict } from '../stream-limits';

describe('selectStreamToEvict', () => {
  const now = 1_000_000;

  it('picks the least recently accessed idle stream', () => {
    const evicted = selectStreamToEvict(
      [
        { id: 'a', lastAccess: now - 60_000 },
        { id: 'b', lastAccess: now - 120_000 },
        { id: 'c', lastAccess: now - 90_000 }
      ],
      { now, minIdleMs: 15_000 }
    );

    expect(evicted).toBe('b');
  });

  it('refuses to evict a stream that is still being watched', () => {
    const evicted = selectStreamToEvict(
      [
        { id: 'a', lastAccess: now - 2_000 },
        { id: 'b', lastAccess: now - 5_000 }
      ],
      { now, minIdleMs: 15_000 }
    );

    expect(evicted).toBeNull();
  });

  it('never evicts a protected stream even when it is the oldest', () => {
    const evicted = selectStreamToEvict(
      [
        { id: 'incoming', lastAccess: now - 300_000 },
        { id: 'idle', lastAccess: now - 40_000 }
      ],
      { now, minIdleMs: 15_000, protectIds: ['incoming'] }
    );

    expect(evicted).toBe('idle');
  });

  it('returns null when there is nothing to evict', () => {
    expect(selectStreamToEvict([], { now, minIdleMs: 15_000 })).toBeNull();
  });
});

describe('findOrphanStreamDirs', () => {
  const now = 1_000_000;

  it('returns only directories with no active stream', () => {
    const orphans = findOrphanStreamDirs(
      [
        { name: 'live', modifiedMs: now - 120_000 },
        { name: 'abandoned', modifiedMs: now - 120_000 }
      ],
      ['live'],
      { now, minAgeMs: 60_000 }
    );

    expect(orphans).toEqual(['abandoned']);
  });

  it('leaves freshly created directories alone', () => {
    const orphans = findOrphanStreamDirs(
      [{ name: 'starting-up', modifiedMs: now - 1_000 }],
      [],
      { now, minAgeMs: 60_000 }
    );

    expect(orphans).toEqual([]);
  });
});
