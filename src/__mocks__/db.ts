/**
 * Jest Manual Mock for db module
 * 
 * This file is automatically loaded by Jest when any test imports from '../db'
 * Place in src/__mocks__/db.ts (mirrors src/db.ts path)
 */

// Create the mock functions
export const mockExecute = jest.fn();
export const mockGetSetting = jest.fn();
export const mockSetSetting = jest.fn();
export const mockInitDb = jest.fn();

// The mock db object matching the real db interface
export const db = {
  execute: mockExecute
};

// Mock the constants
export const DB_DIR = '/tmp/test-data';

// Mock the functions
export const getSetting = mockGetSetting;
export const setSetting = mockSetSetting;
export const initDb = mockInitDb;

/**
 * Reset all mocks - call in beforeEach
 */
export function resetDbMocks() {
  mockExecute.mockReset();
  mockGetSetting.mockReset();
  mockSetSetting.mockReset();
  mockInitDb.mockReset();
  
  // Set up default resolved values
  mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0 });
  mockGetSetting.mockResolvedValue(null);
  mockSetSetting.mockResolvedValue(undefined);
  mockInitDb.mockResolvedValue(undefined);
}

/**
 * Helper to mock a SELECT query returning rows
 */
export function mockSelectResponse(rows: any[]) {
  mockExecute.mockResolvedValueOnce({ rows, rowsAffected: 0 });
}

/**
 * Helper to mock an INSERT/UPDATE/DELETE query
 */
export function mockModifyResponse(rowsAffected: number) {
  mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected });
}

/**
 * Helper to mock multiple sequential db calls
 */
export function mockDbSequence(responses: Array<{ rows?: any[], rowsAffected?: number }>) {
  responses.forEach(resp => {
    mockExecute.mockResolvedValueOnce({
      rows: resp.rows || [],
      rowsAffected: resp.rowsAffected || 0
    });
  });
}

/**
 * Helper to make the next db call throw an error
 */
export function mockDbError(message: string) {
  mockExecute.mockRejectedValueOnce(new Error(message));
}

// Initialize with defaults
resetDbMocks();
