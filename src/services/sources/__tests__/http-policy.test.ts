import {
  backoffDelayMs,
  buildConditionalHeaders,
  DEFAULT_BACKOFF,
  DEFAULT_BREAKER,
  exceedsByteCap,
  isBreakerOpen,
  isNotModified,
  isRetryableError,
  isRetryableStatus,
  parseRetryAfter,
  recordBreakerFailure,
  recordBreakerSuccess
} from '../http-policy';

describe('conditional requests', () => {
  it('sends both validators when it has them', () => {
    expect(buildConditionalHeaders({ etag: 'W/"abc"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' }))
      .toEqual({ 'If-None-Match': 'W/"abc"', 'If-Modified-Since': 'Wed, 21 Oct 2026 07:28:00 GMT' });
  });

  it('sends nothing on a first fetch', () => {
    expect(buildConditionalHeaders(null)).toEqual({});
    expect(buildConditionalHeaders({ etag: null, lastModified: null })).toEqual({});
  });

  it('recognises a 304 so an unchanged feed is never re-parsed', () => {
    expect(isNotModified(304)).toBe(true);
    expect(isNotModified(200)).toBe(false);
  });
});

describe('retry classification', () => {
  it('retries transient server and rate-limit responses', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('does not retry a response that will not change', () => {
    for (const status of [200, 301, 400, 401, 403, 404, 410]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('retries transient socket errors only', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableError({ code: 'CERT_HAS_EXPIRED' })).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially from the base', () => {
    const noJitter = () => 0;
    expect(backoffDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, noJitter)).toBe(4000);
  });

  it('never exceeds the cap, even with full jitter', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      expect(backoffDelayMs(attempt, DEFAULT_BACKOFF, () => 1)).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
    }
  });

  it('adds jitter so retries from many sources do not align', () => {
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, () => 0))
      .toBeLessThan(backoffDelayMs(2, DEFAULT_BACKOFF, () => 1));
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');

  it('handles the seconds form', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('handles the http-date form', () => {
    expect(parseRetryAfter('Fri, 14 Aug 2026 12:02:00 GMT', now)).toBe(120_000);
  });

  it('never returns a negative wait for a date in the past', () => {
    expect(parseRetryAfter('Fri, 14 Aug 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});

describe('circuit breaker', () => {
  const now = 1_000_000_000;

  it('stays closed below the threshold', () => {
    let state = recordBreakerFailure(undefined, now);
    state = recordBreakerFailure(state, now);
    expect(state.consecutiveFailures).toBe(2);
    expect(isBreakerOpen(state, now)).toBe(false);
  });

  it('opens at the threshold and closes after the cooldown', () => {
    let state;
    for (let i = 0; i < DEFAULT_BREAKER.threshold; i++) {
      state = recordBreakerFailure(state, now);
    }
    expect(isBreakerOpen(state, now)).toBe(true);
    expect(isBreakerOpen(state, now + DEFAULT_BREAKER.cooldownMs + 1)).toBe(false);
  });

  it('a success clears the record', () => {
    let state;
    for (let i = 0; i < DEFAULT_BREAKER.threshold; i++) {
      state = recordBreakerFailure(state, now);
    }
    expect(isBreakerOpen(recordBreakerSuccess(), now)).toBe(false);
  });
});

describe('exceedsByteCap', () => {
  it('enforces a cap when one is set', () => {
    expect(exceedsByteCap(1024, 512)).toBe(true);
    expect(exceedsByteCap(256, 512)).toBe(false);
  });

  it('treats an absent or zero cap as unlimited', () => {
    expect(exceedsByteCap(Number.MAX_SAFE_INTEGER, undefined)).toBe(false);
    expect(exceedsByteCap(Number.MAX_SAFE_INTEGER, 0)).toBe(false);
  });
});
