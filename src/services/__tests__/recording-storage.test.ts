import {
  evaluateRetention,
  meetsFreeSpaceFloor,
  resolveRecordingPath,
  type RetentionCandidate,
  type RetentionPolicy
} from '../recording-storage';

const BASE = '/data/recordings';

describe('resolveRecordingPath', () => {
  it('resolves a plain filename inside the recordings directory', () => {
    expect(resolveRecordingPath(BASE, 'The_Show_123.mp4')).toBe('/data/recordings/The_Show_123.mp4');
  });

  it('rejects traversal in every form', () => {
    expect(resolveRecordingPath(BASE, '../local.db')).toBeNull();
    expect(resolveRecordingPath(BASE, '../../etc/passwd.mp4')).toBeNull();
    expect(resolveRecordingPath(BASE, '/etc/passwd.mp4')).toBeNull();
    expect(resolveRecordingPath(BASE, 'nested/show.mp4')).toBeNull();
    expect(resolveRecordingPath(BASE, '..')).toBeNull();
  });

  it('rejects empty, blank and null-byte input', () => {
    expect(resolveRecordingPath(BASE, '')).toBeNull();
    expect(resolveRecordingPath(BASE, '   ')).toBeNull();
    expect(resolveRecordingPath(BASE, 'show.mp4\0.png')).toBeNull();
  });

  it('enforces the extension allowlist when given one', () => {
    const opts = { allowedExtensions: ['.mp4'] };
    expect(resolveRecordingPath(BASE, 'show.mp4', opts)).toBe('/data/recordings/show.mp4');
    expect(resolveRecordingPath(BASE, 'show.MP4', opts)).toBe('/data/recordings/show.MP4');
    expect(resolveRecordingPath(BASE, 'local.db', opts)).toBeNull();
  });
});

describe('evaluateRetention', () => {
  const now = Date.parse('2026-08-13T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const gb = 1024 * 1024 * 1024;

  const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
    mode: 'age',
    maxAgeDays: 30,
    budgetBytes: 50 * gb,
    minFreeBytes: 2 * gb,
    ...over
  });

  const rec = (over: Partial<RetentionCandidate> = {}): RetentionCandidate => ({
    id: 1,
    filename: 'show.mp4',
    status: 'completed',
    completedAtMs: now,
    sizeBytes: gb,
    ...over
  });

  it('prunes completed recordings past the age cutoff', () => {
    const decision = evaluateRetention(
      [
        rec({ id: 1, completedAtMs: now - 40 * day }),
        rec({ id: 2, completedAtMs: now - 31 * day }),
        rec({ id: 3, completedAtMs: now - 29 * day })
      ],
      policy(),
      { now, freeBytes: 100 * gb }
    );

    expect(decision.prune.map(r => r.id)).toEqual([1, 2]);
  });

  it('never prunes recordings that are scheduled or in flight', () => {
    const decision = evaluateRetention(
      [
        rec({ id: 1, status: 'recording', completedAtMs: now - 90 * day }),
        rec({ id: 2, status: 'scheduled', completedAtMs: now - 90 * day }),
        rec({ id: 3, status: 'failed', completedAtMs: now - 90 * day }),
        rec({ id: 4, status: 'completed', filename: null, completedAtMs: now - 90 * day })
      ],
      policy(),
      { now, freeBytes: 100 * gb }
    );

    expect(decision.prune).toEqual([]);
  });

  it('deletes nothing when retention is off, however old the library', () => {
    const decision = evaluateRetention(
      [rec({ completedAtMs: now - 900 * day })],
      policy({ mode: 'off' }),
      { now, freeBytes: 0 }
    );

    expect(decision.prune).toEqual([]);
  });

  it('prunes oldest first until back under the size budget', () => {
    const decision = evaluateRetention(
      [
        rec({ id: 1, completedAtMs: now - 3 * day, sizeBytes: 4 * gb }),
        rec({ id: 2, completedAtMs: now - 2 * day, sizeBytes: 4 * gb }),
        rec({ id: 3, completedAtMs: now - 1 * day, sizeBytes: 4 * gb })
      ],
      policy({ mode: 'size', budgetBytes: 6 * gb }),
      { now, freeBytes: 100 * gb }
    );

    expect(decision.prune.map(r => r.id)).toEqual([1, 2]);
  });

  it('only acts under low-space mode when free space is below the floor', () => {
    const library = [
      rec({ id: 1, completedAtMs: now - 3 * day, sizeBytes: 2 * gb }),
      rec({ id: 2, completedAtMs: now - 1 * day, sizeBytes: 2 * gb })
    ];
    const lowSpace = policy({ mode: 'low-space', minFreeBytes: 5 * gb });

    expect(evaluateRetention(library, lowSpace, { now, freeBytes: 10 * gb }).prune).toEqual([]);
    expect(
      evaluateRetention(library, lowSpace, { now, freeBytes: 4 * gb }).prune.map(r => r.id)
    ).toEqual([1]);
  });
});

describe('meetsFreeSpaceFloor', () => {
  it('gates on the configured floor', () => {
    expect(meetsFreeSpaceFloor(3_000_000_000, 2_000_000_000)).toBe(true);
    expect(meetsFreeSpaceFloor(1_000_000_000, 2_000_000_000)).toBe(false);
  });
});
