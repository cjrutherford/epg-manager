import { eventBus, emitLog, emitProgress, emitProgressComplete, LogMessage, ProgressUpdate } from '../events';

describe('events module', () => {
  beforeEach(() => {
    // Clear all listeners before each test
    eventBus.removeAllListeners();
  });

  describe('emitLog', () => {
    it('emits log event with info type by default', (done) => {
      eventBus.once('log', (log: LogMessage) => {
        expect(log.type).toBe('info');
        expect(log.message).toBe('Test message');
        expect(typeof log.timestamp).toBe('number');
        done();
      });
      
      emitLog('Test message');
    });

    it('emits log event with specified type', (done) => {
      eventBus.once('log', (log: LogMessage) => {
        expect(log.type).toBe('error');
        expect(log.message).toBe('Error message');
        done();
      });
      
      emitLog('Error message', 'error');
    });

    it('emits log event with success type', (done) => {
      eventBus.once('log', (log: LogMessage) => {
        expect(log.type).toBe('success');
        done();
      });
      
      emitLog('Success!', 'success');
    });

    it('emits log event with warning type', (done) => {
      eventBus.once('log', (log: LogMessage) => {
        expect(log.type).toBe('warning');
        done();
      });
      
      emitLog('Warning!', 'warning');
    });

    it('includes timestamp in log event', (done) => {
      const before = Date.now();
      eventBus.once('log', (log: LogMessage) => {
        const after = Date.now();
        expect(log.timestamp).toBeGreaterThanOrEqual(before);
        expect(log.timestamp).toBeLessThanOrEqual(after);
        done();
      });
      
      emitLog('Test');
    });
  });

  describe('emitProgress', () => {
    it('emits progress event with grab phase by default', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.phase).toBe('grab');
        expect(progress.message).toBe('Progress message');
        expect(progress.current).toBe(5);
        expect(progress.total).toBe(10);
        done();
      });
      
      emitProgress('Progress message', 5, 10);
    });

    it('emits progress event with specified phase', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.phase).toBe('match');
        done();
      });
      
      emitProgress('Matching', 1, 5, 'match');
    });

    it('emits progress event with enrich phase', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.phase).toBe('enrich');
        done();
      });
      
      emitProgress('Enriching', 1, 5, 'enrich');
    });

    it('sets completed to true when current >= total', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.completed).toBe(true);
        done();
      });
      
      emitProgress('Done', 10, 10);
    });

    it('sets completed to true when current > total', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.completed).toBe(true);
        done();
      });
      
      emitProgress('Overflow', 15, 10);
    });

    it('sets completed to false when current < total', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.completed).toBe(false);
        done();
      });
      
      emitProgress('In progress', 5, 10);
    });

    it('sets completed to false when total is 0', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.completed).toBe(false);
        done();
      });
      
      emitProgress('No total', 0, 0);
    });
  });

  describe('emitProgressComplete', () => {
    it('emits progress complete event', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.phase).toBe('grab');
        expect(progress.message).toBe('Complete!');
        expect(progress.current).toBe(100);
        expect(progress.total).toBe(100);
        expect(progress.completed).toBe(true);
        done();
      });
      
      emitProgressComplete('grab', 'Complete!', 100);
    });

    it('emits complete event for match phase', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.phase).toBe('match');
        expect(progress.completed).toBe(true);
        done();
      });
      
      emitProgressComplete('match', 'Matching complete', 50);
    });

    it('emits complete event for enrich phase', (done) => {
      eventBus.once('progress', (progress: ProgressUpdate) => {
        expect(progress.phase).toBe('enrich');
        expect(progress.completed).toBe(true);
        done();
      });
      
      emitProgressComplete('enrich', 'Enrichment complete', 200);
    });
  });
});
