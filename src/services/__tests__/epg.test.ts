import { normalizeId, cleanName, getText } from '../epg';

describe('epg service', () => {
  describe('normalizeId', () => {
    it('removes @ suffix', () => {
      expect(normalizeId('HBO@us')).toBe('hbo');
    });

    it('removes .us suffix', () => {
      expect(normalizeId('ESPN.us')).toBe('espn');
    });

    it('removes .us with number suffix', () => {
      expect(normalizeId('ESPN.us1')).toBe('espn');
    });

    it('removes parenthetical content', () => {
      expect(normalizeId('CNN(US)')).toBe('cnn');
    });

    it('removes bracketed content', () => {
      expect(normalizeId('BBC[HD]')).toBe('bbc');
    });

    it('converts to lowercase', () => {
      expect(normalizeId('DisneyChannel')).toBe('disneychannel');
    });

    it('removes special characters', () => {
      expect(normalizeId('A&E')).toBe('ae');
    });

    it('handles complex ID', () => {
      expect(normalizeId('Fox.Sports.1@us')).toBe('foxsports1');
    });
  });

  describe('cleanName', () => {
    it('removes parenthetical content', () => {
      expect(cleanName('CNN (US)')).toBe('CNN');
    });

    it('removes bracketed content', () => {
      expect(cleanName('BBC [HD]')).toBe('BBC');
    });

    it('removes resolution indicators (1080p)', () => {
      expect(cleanName('ESPN 1080p')).toBe('ESPN');
    });

    it('removes resolution indicators (720p)', () => {
      expect(cleanName('HBO 720p')).toBe('HBO');
    });

    it('removes quality indicators (HD)', () => {
      expect(cleanName('Discovery HD')).toBe('Discovery');
    });

    it('removes quality indicators (FHD)', () => {
      expect(cleanName('Showtime FHD')).toBe('Showtime');
    });

    it('removes quality indicators (4K)', () => {
      expect(cleanName('Netflix 4K')).toBe('Netflix');
    });

    it('removes country prefix (US:)', () => {
      expect(cleanName('US: CNN')).toBe('CNN');
    });

    it('removes country prefix (UK:)', () => {
      expect(cleanName('UK: BBC One')).toBe('BBC One');
    });

    it('removes country prefix (FRANCE:)', () => {
      expect(cleanName('FRANCE: TF1')).toBe('TF1');
    });

    it('removes special characters', () => {
      expect(cleanName('A&E Network')).toBe('AE Network');
    });

    it('normalizes spaces', () => {
      expect(cleanName('Fox   Sports   1')).toBe('Fox Sports 1');
    });

    it('trims whitespace', () => {
      expect(cleanName('  ABC  ')).toBe('ABC');
    });
  });

  describe('getText', () => {
    it('returns empty string for null', () => {
      expect(getText(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(getText(undefined)).toBe('');
    });

    it('escapes ampersand', () => {
      expect(getText('A & B')).toBe('A &amp; B');
    });

    it('escapes less than', () => {
      expect(getText('a < b')).toBe('a &lt; b');
    });

    it('escapes greater than', () => {
      expect(getText('a > b')).toBe('a &gt; b');
    });

    it('escapes double quotes', () => {
      expect(getText('He said "hello"')).toBe('He said &quot;hello&quot;');
    });

    it('escapes single quotes', () => {
      expect(getText("It's a test")).toBe("It&apos;s a test");
    });

    it('handles numbers', () => {
      expect(getText(123)).toBe('123');
    });

    it('handles multiple special characters', () => {
      expect(getText('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D');
    });
  });
});
