import { normalizeTitle } from '../metadata';

describe('metadata service', () => {
  describe('normalizeTitle', () => {
    it('extracts show name from title:episode format', () => {
      expect(normalizeTitle('The Simpsons: Homer\'s Odyssey')).toBe('the simpsons');
    });

    it('handles Game of Thrones style titles', () => {
      expect(normalizeTitle('Game of Thrones: The Iron Throne')).toBe('game of thrones');
    });

    it('removes quality indicators (HD)', () => {
      expect(normalizeTitle('Breaking Bad HD')).toBe('breaking bad');
    });

    it('removes quality indicators (1080p)', () => {
      expect(normalizeTitle('Breaking Bad 1080p')).toBe('breaking bad');
    });

    it('removes quality indicators (4K)', () => {
      expect(normalizeTitle('Planet Earth 4K')).toBe('planet earth');
    });

    it('removes episode markers (S01E01)', () => {
      expect(normalizeTitle('Friends S01E01')).toBe('friends');
    });

    it('removes episode markers (s02e15)', () => {
      expect(normalizeTitle('The Office s02e15')).toBe('the office');
    });

    it('removes season words', () => {
      expect(normalizeTitle('Stranger Things Season 4')).toBe('stranger things');
    });

    it('removes episode words', () => {
      expect(normalizeTitle('Better Call Saul Episode 10')).toBe('better call saul');
    });

    it('removes years in parentheses', () => {
      expect(normalizeTitle('The Crown (2016)')).toBe('the crown');
    });

    it('handles unicode characters', () => {
      expect(normalizeTitle('Café Müller')).toBe('café müller');
    });

    it('handles Chinese characters', () => {
      expect(normalizeTitle('三体')).toBe('三体');
    });

    it('handles Japanese characters', () => {
      expect(normalizeTitle('ワンピース')).toBe('ワンピース');
    });

    it('handles Arabic characters', () => {
      expect(normalizeTitle('مسلسل')).toBe('مسلسل');
    });

    it('normalizes multiple spaces', () => {
      expect(normalizeTitle('The   Big   Bang   Theory')).toBe('the big bang theory');
    });

    it('trims whitespace', () => {
      expect(normalizeTitle('  House M.D.  ')).toBe('house m d');
    });

    it('handles short first part before colon', () => {
      // If first part is <= 2 chars, uses full title
      expect(normalizeTitle('TV: Special Show')).toBe('tv special show');
    });

    it('handles x264 codec indicator', () => {
      expect(normalizeTitle('Movie Name x264')).toBe('movie name');
    });

    it('handles HEVC codec indicator', () => {
      expect(normalizeTitle('Documentary HEVC')).toBe('documentary');
    });
  });
});
