import { currentJob, startJob, completeJob, getJobStatus } from '../job';

describe('job module', () => {
  // Reset job state before each test
  beforeEach(() => {
    currentJob.running = false;
    currentJob.startTime = null;
    currentJob.endTime = null;
    currentJob.stats = null;
  });

  describe('startJob', () => {
    it('sets running to true', () => {
      startJob();
      expect(currentJob.running).toBe(true);
    });

    it('sets startTime to current time', () => {
      const before = Date.now();
      startJob();
      const after = Date.now();
      
      expect(currentJob.startTime).toBeGreaterThanOrEqual(before);
      expect(currentJob.startTime).toBeLessThanOrEqual(after);
    });

    it('clears endTime', () => {
      currentJob.endTime = Date.now();
      startJob();
      expect(currentJob.endTime).toBeNull();
    });

    it('clears stats', () => {
      currentJob.stats = {
        channelsProcessed: 10,
        programsProcessed: 100,
        channelsMatched: 5,
        totalChannels: 10,
        filesGenerated: ['test.m3u'],
        customGrabCount: 3
      };
      startJob();
      expect(currentJob.stats).toBeNull();
    });
  });

  describe('completeJob', () => {
    it('sets running to false', () => {
      currentJob.running = true;
      completeJob(null);
      expect(currentJob.running).toBe(false);
    });

    it('sets endTime to current time', () => {
      const before = Date.now();
      completeJob(null);
      const after = Date.now();
      
      expect(currentJob.endTime).toBeGreaterThanOrEqual(before);
      expect(currentJob.endTime).toBeLessThanOrEqual(after);
    });

    it('sets stats to provided value', () => {
      const stats = {
        channelsProcessed: 50,
        programsProcessed: 500,
        channelsMatched: 40,
        totalChannels: 50,
        filesGenerated: ['playlist.m3u', 'epg.xml'],
        customGrabCount: 10
      };
      
      completeJob(stats);
      expect(currentJob.stats).toEqual(stats);
    });

    it('handles null stats', () => {
      completeJob(null);
      expect(currentJob.stats).toBeNull();
    });
  });

  describe('getJobStatus', () => {
    it('returns a copy of job status', () => {
      startJob();
      const status1 = getJobStatus();
      const status2 = getJobStatus();
      
      expect(status1).toEqual(status2);
      expect(status1).not.toBe(currentJob); // Different object
    });

    it('returns running state', () => {
      currentJob.running = true;
      expect(getJobStatus().running).toBe(true);
      
      currentJob.running = false;
      expect(getJobStatus().running).toBe(false);
    });

    it('returns startTime', () => {
      const time = Date.now();
      currentJob.startTime = time;
      expect(getJobStatus().startTime).toBe(time);
    });

    it('returns endTime', () => {
      const time = Date.now();
      currentJob.endTime = time;
      expect(getJobStatus().endTime).toBe(time);
    });

    it('returns stats', () => {
      const stats = {
        channelsProcessed: 25,
        programsProcessed: 250,
        channelsMatched: 20,
        totalChannels: 25,
        filesGenerated: ['test.m3u'],
        customGrabCount: 5
      };
      currentJob.stats = stats;
      expect(getJobStatus().stats).toEqual(stats);
    });

    it('modifications to returned object do not affect original', () => {
      startJob();
      const status = getJobStatus();
      status.running = false;
      
      expect(currentJob.running).toBe(true); // Original unchanged
    });
  });
});
