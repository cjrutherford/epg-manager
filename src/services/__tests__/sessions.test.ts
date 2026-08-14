import {
  checkThrottle,
  createAttemptState,
  DEFAULT_THROTTLE,
  hashToken,
  isSessionValid,
  isWeakPassword,
  passwordMatches,
  pruneAttemptStates,
  pruneExpiredSessions,
  registerFailure,
  registerSuccess
} from '../sessions';

describe('token handling', () => {
  it('hashes deterministically and does not echo the token', () => {
    const token = 'a3f1c2d4-0000-4000-8000-000000000000';
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('gives different hashes for different tokens', () => {
    expect(hashToken('one')).not.toBe(hashToken('two'));
  });
});

describe('passwordMatches', () => {
  it('accepts the correct password and rejects everything else', () => {
    expect(passwordMatches('hunter2', 'hunter2')).toBe(true);
    expect(passwordMatches('hunter3', 'hunter2')).toBe(false);
    expect(passwordMatches('', 'hunter2')).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(passwordMatches(undefined, 'hunter2')).toBe(false);
    expect(passwordMatches(null, 'hunter2')).toBe(false);
    expect(passwordMatches({ toString: () => 'hunter2' }, 'hunter2')).toBe(false);
  });

  it('handles a length mismatch without throwing', () => {
    expect(() => passwordMatches('short', 'a-much-longer-password')).not.toThrow();
    expect(passwordMatches('short', 'a-much-longer-password')).toBe(false);
  });
});

describe('isWeakPassword', () => {
  it('flags the shipped default and common placeholders', () => {
    expect(isWeakPassword('admin')).toBe(true);
    expect(isWeakPassword('ADMIN')).toBe(true);
    expect(isWeakPassword('changeme')).toBe(true);
    expect(isWeakPassword('')).toBe(true);
    expect(isWeakPassword('correct horse battery staple')).toBe(false);
  });
});

describe('session expiry', () => {
  const now = 1_000_000;

  it('treats a future expiry as valid and a past one as not', () => {
    expect(isSessionValid(now + 1000, now)).toBe(true);
    expect(isSessionValid(now - 1000, now)).toBe(false);
    expect(isSessionValid(undefined, now)).toBe(false);
  });

  it('prunes only expired sessions and reports what it removed', () => {
    const sessions = new Map<string, number>([
      ['live', now + 60_000],
      ['stale', now - 60_000],
      ['boundary', now]
    ]);

    const removed = pruneExpiredSessions(sessions, now);

    expect(removed.sort()).toEqual(['boundary', 'stale']);
    expect([...sessions.keys()]).toEqual(['live']);
  });
});

describe('login throttling', () => {
  const now = 1_000_000;

  it('allows attempts until the ceiling, then blocks', () => {
    let state = createAttemptState();
    for (let i = 0; i < DEFAULT_THROTTLE.maxFailures - 1; i++) {
      state = registerFailure(state, now);
      expect(checkThrottle(state, now).allowed).toBe(true);
    }

    state = registerFailure(state, now);
    const verdict = checkThrottle(state, now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterMs).toBe(DEFAULT_THROTTLE.blockMs);
  });

  it('lets the block lapse', () => {
    let state = createAttemptState();
    for (let i = 0; i < DEFAULT_THROTTLE.maxFailures; i++) {
      state = registerFailure(state, now);
    }

    expect(checkThrottle(state, now).allowed).toBe(false);
    expect(checkThrottle(state, now + DEFAULT_THROTTLE.blockMs + 1).allowed).toBe(true);
  });

  it('forgets failures once the window lapses', () => {
    let state = registerFailure(createAttemptState(), now);
    expect(state.failures).toBe(1);

    state = registerFailure(state, now + DEFAULT_THROTTLE.windowMs + 1);
    expect(state.failures).toBe(1);
  });

  it('clears the record on success', () => {
    expect(registerSuccess()).toEqual(createAttemptState());
    expect(checkThrottle(registerSuccess(), now).allowed).toBe(true);
  });

  it('treats an unknown caller as allowed', () => {
    expect(checkThrottle(undefined, now).allowed).toBe(true);
  });

  it('prunes records that are neither blocking nor recent', () => {
    const states = new Map([
      ['blocked', { failures: 0, windowStartedAt: now, blockedUntil: now + 60_000 }],
      ['recent', { failures: 2, windowStartedAt: now, blockedUntil: 0 }],
      ['stale', { failures: 1, windowStartedAt: now - DEFAULT_THROTTLE.windowMs - 1, blockedUntil: 0 }]
    ]);

    const removed = pruneAttemptStates(states, now);

    expect(removed).toBe(1);
    expect([...states.keys()].sort()).toEqual(['blocked', 'recent']);
  });
});
