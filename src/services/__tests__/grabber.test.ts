/**
 * Grabber Service Tests
 * 
 * Tests for the grabber service functions with proper db mocking
 */

// Create mock function BEFORE jest.mock
const mockExecute = jest.fn();

// Mock db inline with factory function
jest.mock('../../db', () => ({
  db: { execute: mockExecute },
  DB_DIR: '/tmp/test-data',
  getSetting: jest.fn(),
  setSetting: jest.fn()
}));

// Mock the events module
jest.mock('../../events', () => ({
  emitLog: jest.fn(),
  emitProgress: jest.fn(),
  emitProgressComplete: jest.fn()
}));

// Mock the epg module
jest.mock('../epg', () => ({
  processEpg: jest.fn().mockResolvedValue({ total: 10 })
}));

// Mock fs
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue('{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn()
}));

// Import the functions to test AFTER mocking
import { getAutoDisabledChannels, reEnableChannels } from '../grabber';

describe('grabber service', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });
  });

  describe('getAutoDisabledChannels', () => {
    it('should call db.execute to query channel_grab_status', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      
      await getAutoDisabledChannels();
      
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no auto-disabled channels exist', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      
      const result = await getAutoDisabledChannels();
      
      expect(result).toEqual([]);
    });

    it('should return array of disabled channels from database', async () => {
      mockExecute.mockResolvedValue({
        rows: [
          { xmltv_id: 'channel1.us', consecutive_failures: 5 },
          { xmltv_id: 'channel2.uk', consecutive_failures: 7 }
        ]
      });
      
      const result = await getAutoDisabledChannels();
      
      expect(result).toHaveLength(2);
      expect(result[0].xmltv_id).toBe('channel1.us');
      expect(result[1].xmltv_id).toBe('channel2.uk');
    });

    it('should query for auto_disabled channels', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      
      await getAutoDisabledChannels();
      
      const call = mockExecute.mock.calls[0][0];
      // Check that sql exists (might be a string or object with sql property)
      const sql = typeof call === 'string' ? call : call.sql;
      expect(sql).toContain('channel_grab_status');
    });
  });

  describe('reEnableChannels', () => {
    it('should return 0 and not call db when given empty array', async () => {
      const result = await reEnableChannels([]);
      
      expect(result).toBe(0);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should call db.execute when re-enabling channels', async () => {
      mockExecute.mockResolvedValue({ rowsAffected: 1 });
      
      await reEnableChannels(['test.channel']);
      
      expect(mockExecute).toHaveBeenCalled();
    });

    it('should handle multiple channels', async () => {
      mockExecute.mockResolvedValue({ rowsAffected: 3 });
      
      await reEnableChannels(['ch1', 'ch2', 'ch3']);
      
      expect(mockExecute).toHaveBeenCalled();
    });
  });
});
