import {
  isRefreshDue,
  normalizeDescriptor,
  parseDuration,
  redactDescriptor,
  redactUrl,
  slugifySourceId,
  validateDescriptor,
  type SourceDescriptor
} from '../descriptor';

const base = (over: Partial<SourceDescriptor> = {}): SourceDescriptor => ({
  id: 'epgshare01-us',
  kind: 'xmltv',
  label: 'EPGShare 01 — United States',
  provides: ['guide'],
  enabled: true,
  priority: 90,
  fetch: { url: 'https://epgshare01.online/epg_ripper_US1.xml.gz', compression: 'gzip', refresh: '12h' },
  ...over
});

describe('parseDuration', () => {
  it('parses the supported units', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('45m')).toBe(2_700_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('returns null for anything else', () => {
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('12')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
});

describe('slugifySourceId', () => {
  it('produces a stable, url-safe id', () => {
    expect(slugifySourceId('EPGShare 01 — US!')).toBe('epgshare-01-us');
    expect(slugifySourceId('   ')).toBe('source');
  });
});

describe('validateDescriptor', () => {
  it('accepts a well-formed descriptor', () => {
    expect(validateDescriptor(base()).valid).toBe(true);
  });

  it('rejects an unknown kind', () => {
    const result = validateDescriptor(base({ kind: 'telepathy' as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('kind must be one of');
  });

  it('requires at least one capability', () => {
    expect(validateDescriptor(base({ provides: [] })).valid).toBe(false);
    expect(validateDescriptor(base({ provides: ['sound' as any] })).valid).toBe(false);
  });

  it('requires a fetch url for every kind except file', () => {
    expect(validateDescriptor(base({ fetch: {} })).valid).toBe(false);
    expect(validateDescriptor(base({ kind: 'file', fetch: {} })).valid).toBe(true);
  });

  it('rejects a url that is neither http(s) nor a /files/ path', () => {
    expect(validateDescriptor(base({ fetch: { url: 'ftp://example.com/a.xml' } })).valid).toBe(false);
    expect(validateDescriptor(base({ fetch: { url: 'file:///etc/passwd' } })).valid).toBe(false);
    expect(validateDescriptor(base({ fetch: { url: '/files/iptv-org-playlists/uk.m3u' } })).valid).toBe(true);
  });

  it('rejects an unparseable refresh interval', () => {
    const result = validateDescriptor(base({ fetch: { url: 'https://x/y.xml', refresh: 'often' } }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('fetch.refresh');
  });

  it('collects every problem rather than stopping at the first', () => {
    const result = validateDescriptor({ kind: 'nope', provides: [] });
    expect(result.errors.length).toBeGreaterThan(2);
  });
});

describe('normalizeDescriptor', () => {
  it('fills defaults and dedupes capabilities', () => {
    const result = normalizeDescriptor(base({
      provides: ['guide', 'guide'],
      fetch: { url: 'https://x/y.xml' }
    }));

    expect(result.provides).toEqual(['guide']);
    expect(result.fetch.refresh).toBe('12h');
    expect(result.fetch.conditional).toBe(true);
    expect(result.credentialRef).toBeNull();
  });

  it('treats a missing enabled flag as enabled', () => {
    expect(normalizeDescriptor(base({ enabled: undefined as any })).enabled).toBe(true);
    expect(normalizeDescriptor(base({ enabled: false })).enabled).toBe(false);
  });
});

describe('redaction', () => {
  it('strips credentials from a url userinfo', () => {
    expect(redactUrl('http://user:hunter2@panel.example.com/get.php'))
      .toContain('***');
    expect(redactUrl('http://user:hunter2@panel.example.com/get.php'))
      .not.toContain('hunter2');
  });

  it('masks secret-looking query parameters', () => {
    const out = redactUrl('http://panel/player_api.php?username=bob&password=hunter2');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***');
  });

  it('never leaks a credential reference as a secret', () => {
    const redacted: any = redactDescriptor(normalizeDescriptor(base({
      kind: 'xtream',
      credentialRef: 'cred_7fa1',
      fetch: { url: 'http://user:hunter2@panel.example.com/player_api.php' }
    })));

    expect(JSON.stringify(redacted)).not.toContain('hunter2');
    expect(redacted.hasCredentials).toBe(true);
  });

  it('leaves a clean url untouched apart from normalisation', () => {
    expect(redactUrl('https://epgshare01.online/epg.xml.gz'))
      .toBe('https://epgshare01.online/epg.xml.gz');
  });
});

describe('isRefreshDue', () => {
  const now = 1_000_000_000;

  it('is due when never synced', () => {
    expect(isRefreshDue(normalizeDescriptor(base()), null, now)).toBe(true);
  });

  it('respects the descriptor cadence', () => {
    const d = normalizeDescriptor(base({ fetch: { url: 'https://x/y.xml', refresh: '12h' } }));
    expect(isRefreshDue(d, now - 11 * 3600_000, now)).toBe(false);
    expect(isRefreshDue(d, now - 13 * 3600_000, now)).toBe(true);
  });

  it('never refreshes a disabled source', () => {
    const d = normalizeDescriptor(base({ enabled: false }));
    expect(isRefreshDue(d, null, now)).toBe(false);
  });
});
