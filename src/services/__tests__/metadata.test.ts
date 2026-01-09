import { normalizeTitle } from '../metadata';

describe('metadata service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('normalizeTitle', () => {
    // Basic normalization
    it('converts to lowercase', () => {
      expect(normalizeTitle('THE SIMPSONS')).toBe('the simpsons');
    });

    it('trims whitespace', () => {
      expect(normalizeTitle('  Breaking Bad  ')).toBe('breaking bad');
    });

    it('normalizes multiple spaces', () => {
      expect(normalizeTitle('The    Big    Bang    Theory')).toBe('the big bang theory');
    });

    // Colon handling (show:episode format)
    it('extracts show name from title:episode format', () => {
      expect(normalizeTitle('The Simpsons: Homer\'s Odyssey')).toBe('the simpsons');
    });

    it('extracts show name from title:subtitle format', () => {
      expect(normalizeTitle('Game of Thrones: The Iron Throne')).toBe('game of thrones');
    });

    it('uses full title if first part is too short', () => {
      expect(normalizeTitle('TV: Special Show')).toBe('tv special show');
    });

    it('handles multiple colons - uses first part', () => {
      expect(normalizeTitle('Star Trek: Deep Space Nine: S01E01')).toBe('star trek');
    });

    // Quality indicators
    it('removes HD indicator', () => {
      expect(normalizeTitle('Breaking Bad HD')).toBe('breaking bad');
    });

    it('removes FHD indicator', () => {
      expect(normalizeTitle('House FHD')).toBe('house');
    });

    it('removes SD indicator', () => {
      expect(normalizeTitle('Friends SD')).toBe('friends');
    });

    it('removes UHD indicator', () => {
      expect(normalizeTitle('Planet Earth UHD')).toBe('planet earth');
    });

    it('removes 4K indicator', () => {
      expect(normalizeTitle('Documentary Series 4K')).toBe('documentary series');
    });

    it('removes 1080p indicator', () => {
      expect(normalizeTitle('Movie Title 1080p')).toBe('movie title');
    });

    it('removes 720p indicator', () => {
      expect(normalizeTitle('Show Name 720p')).toBe('show name');
    });

    it('removes 480p indicator', () => {
      expect(normalizeTitle('Old Show 480p')).toBe('old show');
    });

    it('removes HEVC indicator', () => {
      expect(normalizeTitle('New Series HEVC')).toBe('new series');
    });

    it('removes x264 indicator', () => {
      expect(normalizeTitle('Series Name x264')).toBe('series name');
    });

    it('removes x265 indicator', () => {
      expect(normalizeTitle('Another Series x265')).toBe('another series');
    });

    it('removes h264 indicator', () => {
      expect(normalizeTitle('Show h264')).toBe('show');
    });

    it('removes h.264 indicator', () => {
      expect(normalizeTitle('Show h.264')).toBe('show');
    });

    // Episode markers
    it('removes S01E01 format episode markers', () => {
      expect(normalizeTitle('Friends S01E01')).toBe('friends');
    });

    it('removes s02e15 format episode markers (lowercase)', () => {
      expect(normalizeTitle('The Office s02e15')).toBe('the office');
    });

    it('removes season X format', () => {
      expect(normalizeTitle('Stranger Things Season 4')).toBe('stranger things');
    });

    it('removes episode X format', () => {
      expect(normalizeTitle('Better Call Saul Episode 10')).toBe('better call saul');
    });

    it('removes 1x01 format episode markers', () => {
      expect(normalizeTitle('Breaking Bad 1x01')).toBe('breaking bad');
    });

    // Year handling
    it('removes years in parentheses', () => {
      expect(normalizeTitle('The Crown (2016)')).toBe('the crown');
    });

    it('removes years in parentheses mid-title', () => {
      expect(normalizeTitle('Doctor Who (2005) Special')).toBe('doctor who special');
    });

    // Unicode / International
    it('handles German umlaut characters', () => {
      expect(normalizeTitle('Café Müller')).toBe('café müller');
    });

    it('handles Chinese characters', () => {
      expect(normalizeTitle('三体')).toBe('三体');
    });

    it('handles Japanese characters', () => {
      expect(normalizeTitle('ワンピース')).toBe('ワンピース');
    });

    it('handles Korean characters', () => {
      expect(normalizeTitle('오징어 게임')).toBe('오징어 게임');
    });

    it('handles Arabic characters', () => {
      expect(normalizeTitle('مسلسل')).toBe('مسلسل');
    });

    it('handles Cyrillic characters', () => {
      expect(normalizeTitle('Москва')).toBe('москва');
    });

    it('handles French accented characters', () => {
      expect(normalizeTitle('Les Misérables')).toBe('les misérables');
    });

    it('handles Spanish ñ character', () => {
      expect(normalizeTitle('El Niño')).toBe('el niño');
    });

    // Edge cases
    it('handles empty string', () => {
      expect(normalizeTitle('')).toBe('');
    });

    it('handles string with only spaces', () => {
      expect(normalizeTitle('   ')).toBe('');
    });

    it('handles string with only special characters', () => {
      expect(normalizeTitle('!@#$%')).toBe('');
    });

    it('removes multiple quality indicators', () => {
      expect(normalizeTitle('Movie HD 1080p HEVC')).toBe('movie');
    });

    it('handles combined episode and quality info', () => {
      expect(normalizeTitle('Show S01E05 720p HEVC x265')).toBe('show');
    });
  });
});
