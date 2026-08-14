const mockExecute = jest.fn();

// Inline factory, matching the pattern used by the other service tests: a
// directly-imported __mocks__ module is a separate instance from the one jest
// injects, so its call history stays empty.
jest.mock('../../db', () => ({
  db: { execute: mockExecute },
  DB_DIR: '/tmp/test-data',
  getSetting: jest.fn(),
  setSetting: jest.fn(),
  initDb: jest.fn()
}));
// The grab itself is not under test here; the accounting is.
jest.mock('../grabber', () => ({
  grabSiteBatch: jest.fn().mockResolvedValue([]),
  cancelAllGrabProcesses: jest.fn()
}));
jest.mock('../metadata', () => ({
  enrichProgramsWithMetadata: jest.fn().mockResolvedValue({ enriched: 0 })
}));
jest.mock('../../events', () => ({
  emitLog: jest.fn(),
  emitProgress: jest.fn(),
  emitProgressComplete: jest.fn(),
  eventBus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() }
}));

import { PipelineQueue } from '../pipeline';

/**
 * The grab denominator used to include every matched channel, whether or not a
 * grab-capable source covered it — so `grabsCompleted >= totalToGrab` could
 * never become true and the phase never rendered complete (R5). These lock the
 * accounting to what is actually queued.
 */
describe('grab accounting', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });
  });

  /** One catalogue row per id that has a source. */
  const catalogRows = (ids: string[]) =>
    ids.map(id => ({ xmltv_id: id, site: 'example.com', site_id: `s-${id}`, lang: 'en' }));

  it('counts only ids a source actually covers', async () => {
    const queue = new PipelineQueue('2');
    mockExecute.mockResolvedValueOnce({ rows: catalogRows(['a', 'b']), rowsAffected: 0 });

    await queue.enqueueMatched(['a', 'b', 'c', 'd']);

    const stats = queue.getGrabStats();
    expect(stats.totalToGrab).toBe(2);
    expect(stats.noSource).toBe(2);
    expect(stats.noSourceIds.sort()).toEqual(['c', 'd']);
  });

  it('reports every id as unsourced when the catalogue is empty', async () => {
    const queue = new PipelineQueue('2');
    mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected: 0 });

    await queue.enqueueMatched(['a', 'b']);

    expect(queue.getGrabStats().totalToGrab).toBe(0);
    expect(queue.getGrabStats().noSource).toBe(2);
  });

  it('counts a channel once even when several sources carry it', async () => {
    const queue = new PipelineQueue('2');
    mockExecute.mockResolvedValueOnce({
      rows: [
        { xmltv_id: 'a', site: 'best.com', site_id: '1', lang: 'en' },
        { xmltv_id: 'a', site: 'other.com', site_id: '2', lang: 'en' }
      ],
      rowsAffected: 0
    });

    await queue.enqueueMatched(['a']);

    expect(queue.getGrabStats().totalToGrab).toBe(1);
    expect(queue.getGrabStats().noSource).toBe(0);
  });

  it('ignores ids already queued, so the total is not double counted', async () => {
    const queue = new PipelineQueue('2');
    mockExecute.mockResolvedValueOnce({ rows: catalogRows(['a']), rowsAffected: 0 });
    await queue.enqueueMatched(['a']);

    // Same id again — filtered before it reaches the catalogue query
    await queue.enqueueMatched(['a']);

    expect(queue.getGrabStats().totalToGrab).toBe(1);
  });

  it('accumulates across successive batches', async () => {
    const queue = new PipelineQueue('2');
    mockExecute.mockResolvedValueOnce({ rows: catalogRows(['a']), rowsAffected: 0 });
    await queue.enqueueMatched(['a', 'x']);

    mockExecute.mockResolvedValueOnce({ rows: catalogRows(['b']), rowsAffected: 0 });
    await queue.enqueueMatched(['b', 'y']);

    const stats = queue.getGrabStats();
    expect(stats.totalToGrab).toBe(2);
    expect(stats.noSource).toBe(2);
    expect(stats.noSourceIds.sort()).toEqual(['x', 'y']);
  });

  it('leaves the total reachable — completed can equal it', async () => {
    const queue = new PipelineQueue('2');
    mockExecute.mockResolvedValueOnce({ rows: catalogRows(['a', 'b']), rowsAffected: 0 });
    await queue.enqueueMatched(['a', 'b', 'unsourced']);

    const stats = queue.getGrabStats();
    // Before the fix this was 3, which grabsCompleted could never reach.
    expect(stats.totalToGrab).toBe(2);
    expect(stats.totalToGrab).toBeLessThan(3);
  });
});
