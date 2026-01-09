import { generateId } from '../playlist';

describe('playlist service', () => {
  describe('generateId', () => {
    it('generates consistent hash for same input', () => {
      const id1 = generateId('http://example.com/playlist.m3u', 'Test Channel');
      const id2 = generateId('http://example.com/playlist.m3u', 'Test Channel');
      expect(id1).toBe(id2);
    });

    it('generates different hash for different URL', () => {
      const id1 = generateId('http://example.com/playlist1.m3u', 'Test Channel');
      const id2 = generateId('http://example.com/playlist2.m3u', 'Test Channel');
      expect(id1).not.toBe(id2);
    });

    it('generates different hash for different name', () => {
      const id1 = generateId('http://example.com/playlist.m3u', 'Channel 1');
      const id2 = generateId('http://example.com/playlist.m3u', 'Channel 2');
      expect(id1).not.toBe(id2);
    });

    it('returns 32 character hex string (MD5)', () => {
      const id = generateId('http://example.com/test.m3u', 'Any Channel');
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it('handles empty strings', () => {
      const id = generateId('', '');
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it('handles special characters in URL', () => {
      const id = generateId('http://example.com/playlist?key=value&other=123', 'Channel');
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it('handles unicode characters in name', () => {
      const id = generateId('http://example.com/test.m3u', '日本のチャンネル');
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it('order matters - URL then name', () => {
      const id1 = generateId('abc', 'def');
      const id2 = generateId('def', 'abc'); // Swapped
      expect(id1).not.toBe(id2);
    });
  });
});
