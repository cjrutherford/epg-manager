import { normalizeId, cleanName, getText } from '../epg';

describe('epg service', () => {
  describe('normalizeId', () => {
    // Basic normalization
    it('converts to lowercase', () => {
      expect(normalizeId('HBO')).toBe('hbo');
    });

    it('removes spaces', () => {
      expect(normalizeId('Fox News')).toBe('foxnews');
    });

    // @ suffix handling
    it('removes @us suffix', () => {
      expect(normalizeId('HBO@us')).toBe('hbo');
    });

    it('removes @uk suffix', () => {
      expect(normalizeId('BBC@uk')).toBe('bbc');
    });

    it('removes any @ suffix', () => {
      expect(normalizeId('Channel@anything.here')).toBe('channel');
    });

    // .us suffix handling
    it('removes .us suffix', () => {
      expect(normalizeId('ESPN.us')).toBe('espn');
    });

    it('removes .us1 suffix', () => {
      expect(normalizeId('ESPN.us1')).toBe('espn');
    });

    it('removes .us123 suffix', () => {
      expect(normalizeId('FOX.us123')).toBe('fox');
    });

    // Parenthetical content
    it('removes parenthetical content', () => {
      expect(normalizeId('CNN(US)')).toBe('cnn');
    });

    it('removes parenthetical with spaces', () => {
      expect(normalizeId('ABC (America)')).toBe('abc');
    });

    it('removes multiple parenthetical', () => {
      expect(normalizeId('Channel(One)(Two)')).toBe('channel');
    });

    // Bracketed content
    it('removes bracketed content', () => {
      expect(normalizeId('BBC[HD]')).toBe('bbc');
    });

    it('removes bracketed with spaces', () => {
      expect(normalizeId('CBS [New York]')).toBe('cbs');
    });

    // Special characters
    it('removes dots', () => {
      expect(normalizeId('A.B.C')).toBe('abc');
    });

    it('removes hyphens', () => {
      expect(normalizeId('A-B-C')).toBe('abc');
    });

    it('removes underscores', () => {
      expect(normalizeId('A_B_C')).toBe('abc');
    });

    it('removes ampersand', () => {
      expect(normalizeId('A&E')).toBe('ae');
    });

    it('removes plus sign', () => {
      expect(normalizeId('ESPN+')).toBe('espn');
    });

    // Complex cases
    it('handles complex ID with multiple patterns', () => {
      expect(normalizeId('Fox.Sports.1@us')).toBe('foxsports1');
    });

    it('handles ID with @ that removes suffix', () => {
      // @ removes everything after it
      expect(normalizeId('HBO@Premium')).toBe('hbo');
    });

    // Edge cases
    it('handles empty string', () => {
      expect(normalizeId('')).toBe('');
    });

    it('preserves numbers', () => {
      expect(normalizeId('ESPN2')).toBe('espn2');
    });
  });

  describe('cleanName', () => {
    // Basic cleaning
    it('preserves normal text', () => {
      expect(cleanName('CNN')).toBe('CNN');
    });

    it('trims whitespace', () => {
      expect(cleanName('  ABC  ')).toBe('ABC');
    });

    it('normalizes internal spaces', () => {
      expect(cleanName('Fox   Sports   1')).toBe('Fox Sports 1');
    });

    // Parenthetical content
    it('removes parenthetical content', () => {
      expect(cleanName('CNN (US)')).toBe('CNN');
    });

    it('removes multiple parenthetical', () => {
      expect(cleanName('CNN (US) (HD)')).toBe('CNN');
    });

    // Bracketed content
    it('removes bracketed content', () => {
      expect(cleanName('BBC [HD]')).toBe('BBC');
    });

    it('removes multiple bracketed', () => {
      expect(cleanName('FOX [US] [HD]')).toBe('FOX');
    });

    // Resolution indicators
    it('removes 1080p', () => {
      expect(cleanName('ESPN 1080p')).toBe('ESPN');
    });

    it('removes 720p', () => {
      expect(cleanName('HBO 720p')).toBe('HBO');
    });

    it('removes 480p', () => {
      expect(cleanName('CBS 480p')).toBe('CBS');
    });

    it('removes 4K', () => {
      expect(cleanName('Netflix 4K')).toBe('Netflix');
    });

    // Quality indicators
    it('removes HD', () => {
      expect(cleanName('Discovery HD')).toBe('Discovery');
    });

    it('removes FHD', () => {
      expect(cleanName('Showtime FHD')).toBe('Showtime');
    });

    it('removes SD', () => {
      expect(cleanName('NBC SD')).toBe('NBC');
    });

    it('removes UHD', () => {
      expect(cleanName('AMC UHD')).toBe('AMC');
    });

    it('removes HEVC', () => {
      expect(cleanName('Channel HEVC')).toBe('Channel');
    });

    // Country prefix removal
    it('removes US: prefix', () => {
      expect(cleanName('US: CNN')).toBe('CNN');
    });

    it('removes UK: prefix', () => {
      expect(cleanName('UK: BBC One')).toBe('BBC One');
    });

    it('removes CA: prefix', () => {
      expect(cleanName('CA: CBC')).toBe('CBC');
    });

    it('removes AU: prefix', () => {
      expect(cleanName('AU: Seven')).toBe('Seven');
    });

    it('removes ES: prefix', () => {
      expect(cleanName('ES: Antena 3')).toBe('Antena 3');
    });

    it('removes MX: prefix', () => {
      expect(cleanName('MX: Televisa')).toBe('Televisa');
    });

    it('removes FR: prefix', () => {
      expect(cleanName('FR: TF1')).toBe('TF1');
    });

    it('removes DE: prefix', () => {
      expect(cleanName('DE: ARD')).toBe('ARD');
    });

    it('removes IT: prefix', () => {
      expect(cleanName('IT: RAI 1')).toBe('RAI 1');
    });

    it('removes FRANCE: prefix', () => {
      expect(cleanName('FRANCE: TF1')).toBe('TF1');
    });

    it('removes USA: prefix', () => {
      expect(cleanName('USA: CBS')).toBe('CBS');
    });

    // Special characters
    it('removes ampersand', () => {
      expect(cleanName('A&E Network')).toBe('AE Network');
    });

    it('removes special characters', () => {
      expect(cleanName('Foo! Bar?')).toBe('Foo Bar');
    });

    // Complex cases
    it('handles multiple patterns', () => {
      expect(cleanName('US: ESPN HD (Backup) [1080p]')).toBe('ESPN');
    });

    // Edge cases
    it('handles empty string', () => {
      expect(cleanName('')).toBe('');
    });

    it('handles only special chars', () => {
      expect(cleanName('!@#$%')).toBe('');
    });
  });

  describe('getText', () => {
    // Null/undefined handling
    it('returns empty string for null', () => {
      expect(getText(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(getText(undefined)).toBe('');
    });

    // XML escaping
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

    // Multiple escaping
    it('escapes all special characters', () => {
      expect(getText('<script>alert("test")</script>')).toBe('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;');
    });

    it('escapes complex HTML', () => {
      expect(getText('<a href="test">link</a>')).toBe('&lt;a href=&quot;test&quot;&gt;link&lt;/a&gt;');
    });

    // Type conversion
    it('converts numbers to string', () => {
      expect(getText(123)).toBe('123');
    });

    it('converts zero to string', () => {
      expect(getText(0)).toBe('0');
    });

    it('converts boolean true to string', () => {
      expect(getText(true)).toBe('true');
    });

    it('converts boolean false to string', () => {
      expect(getText(false)).toBe('false');
    });

    // Normal text
    it('returns normal text unchanged', () => {
      expect(getText('Normal text')).toBe('Normal text');
    });

    it('preserves whitespace', () => {
      expect(getText('  spaces  ')).toBe('  spaces  ');
    });

    it('preserves newlines', () => {
      expect(getText('line1\nline2')).toBe('line1\nline2');
    });
  });
});
