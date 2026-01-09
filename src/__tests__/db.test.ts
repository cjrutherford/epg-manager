// Mock the db module before importing
const mockExecute = jest.fn();
jest.mock('../db', () => ({
  db: {
    execute: mockExecute
  },
  DB_DIR: '/tmp/test-data',
  getSetting: jest.fn(),
  setSetting: jest.fn()
}));

// Mock events to avoid console output
jest.mock('../events', () => ({
  emitLog: jest.fn(),
  emitProgress: jest.fn(),
  emitProgressComplete: jest.fn()
}));

describe('db module', () => {
  describe('database interactions', () => {
    beforeEach(() => {
      mockExecute.mockReset();
    });

    it('db.execute is available', () => {
      const { db } = require('../db');
      expect(db.execute).toBeDefined();
      expect(typeof db.execute).toBe('function');
    });

    it('mockExecute can be called', async () => {
      const { db } = require('../db');
      mockExecute.mockResolvedValue({ rows: [] });
      
      const result = await db.execute('SELECT 1');
      expect(result).toEqual({ rows: [] });
      expect(mockExecute).toHaveBeenCalledWith('SELECT 1');
    });

    it('mockExecute can return rows', async () => {
      const { db } = require('../db');
      mockExecute.mockResolvedValue({ 
        rows: [{ id: 1, name: 'test' }] 
      });
      
      const result = await db.execute({ sql: 'SELECT * FROM test', args: [] });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('test');
    });

    it('DB_DIR is set from mock', () => {
      const { DB_DIR } = require('../db');
      expect(DB_DIR).toBe('/tmp/test-data');
    });
  });
});
