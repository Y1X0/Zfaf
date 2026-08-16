import { describe, expect, it } from 'vitest';

import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_COOKIE_NAME,
  SESSION_SLIDING_THRESHOLD_MS,
  SESSION_TOKEN_BYTES,
  SESSION_TTL_MS,
  STAFF_SESSION_TTL_MS,
  type SessionRecord,
  clearedSessionCookieAttributes,
  evaluateSession,
  sessionCookieAttributes,
  sessionTtlFor,
} from './session.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(NOW.getTime() + SESSION_TTL_MS),
    revokedAt: null,
    createdAt: NOW,
    lastUsedAt: NOW,
    userAgent: 'test',
    ...overrides,
  };
}

describe('session validity', () => {
  it('accepts a fresh session', () => {
    expect(evaluateSession(session(), NOW).valid).toBe(true);
  });

  it('rejects a missing session', () => {
    const verdict = evaluateSession(null, NOW);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toBe('NOT_FOUND');
  });

  it('rejects an expired session', () => {
    const verdict = evaluateSession(session({ expiresAt: new Date(NOW.getTime() - 1) }), NOW);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toBe('EXPIRED');
  });

  it('rejects a revoked session before checking anything else', () => {
    // Revocation is the whole reason database sessions were chosen over JWT
    // (ADR-0006), so it must take effect immediately.
    const verdict = evaluateSession(session({ revokedAt: NOW }), NOW);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toBe('REVOKED');
  });

  it('rejects a session past the absolute lifetime, however active', () => {
    const old = session({
      createdAt: new Date(NOW.getTime() - SESSION_ABSOLUTE_MAX_MS - 1),
      lastUsedAt: NOW,
      expiresAt: new Date(NOW.getTime() + SESSION_TTL_MS),
    });
    const verdict = evaluateSession(old, NOW);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason).toBe('ABSOLUTE_LIFETIME_EXCEEDED');
  });
});

describe('sliding extension', () => {
  it('does not extend on every request', () => {
    // Extending on each request would mean a database write per request.
    const verdict = evaluateSession(session({ lastUsedAt: NOW }), NOW);
    expect(verdict.valid && verdict.shouldExtend).toBe(false);
  });

  it('extends once the session has been idle past the threshold', () => {
    const idle = session({
      lastUsedAt: new Date(NOW.getTime() - SESSION_SLIDING_THRESHOLD_MS - 1),
    });
    const verdict = evaluateSession(idle, NOW);
    expect(verdict.valid && verdict.shouldExtend).toBe(true);
    if (verdict.valid && verdict.newExpiresAt) {
      expect(verdict.newExpiresAt.getTime()).toBe(NOW.getTime() + SESSION_TTL_MS);
    }
  });

  it('never extends beyond the absolute cap', () => {
    // Otherwise a continuously used session would live forever.
    const nearCap = session({
      createdAt: new Date(NOW.getTime() - SESSION_ABSOLUTE_MAX_MS + 60_000),
      lastUsedAt: new Date(NOW.getTime() - SESSION_SLIDING_THRESHOLD_MS - 1),
    });
    const verdict = evaluateSession(nearCap, NOW);
    expect(verdict.valid && verdict.shouldExtend).toBe(true);
    if (verdict.valid && verdict.newExpiresAt) {
      const cap = nearCap.createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS;
      expect(verdict.newExpiresAt.getTime()).toBe(cap);
      expect(verdict.newExpiresAt.getTime()).toBeLessThan(NOW.getTime() + SESSION_TTL_MS);
    }
  });
});

describe('staff sessions are short', () => {
  it('expire in hours, not weeks', () => {
    expect(sessionTtlFor(true)).toBe(STAFF_SESSION_TTL_MS);
    expect(sessionTtlFor(false)).toBe(SESSION_TTL_MS);
    expect(STAFF_SESSION_TTL_MS).toBeLessThan(SESSION_TTL_MS / 100);
  });
});

describe('cookie attributes', () => {
  it('uses the __Host- prefix', () => {
    // Forces Secure and Path=/ and forbids a Domain, so a compromised subdomain
    // cannot plant a session cookie on the apex.
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  it('sets every protective flag', () => {
    const attributes = sessionCookieAttributes(false);
    expect(attributes.httpOnly).toBe(true);
    expect(attributes.secure).toBe(true);
    expect(attributes.sameSite).toBe('lax');
    expect(attributes.path).toBe('/');
  });

  it('uses Lax rather than Strict, so verification links still work', () => {
    // Strict would break a user arriving from the verification email, which is
    // a normal path. CSRF is additionally covered by an Origin check.
    expect(sessionCookieAttributes(false).sameSite).toBe('lax');
  });

  it('gives staff a shorter cookie lifetime', () => {
    expect(sessionCookieAttributes(true).maxAgeSeconds).toBeLessThan(
      sessionCookieAttributes(false).maxAgeSeconds,
    );
  });

  it('clears the cookie on sign-out', () => {
    expect(clearedSessionCookieAttributes().maxAgeSeconds).toBe(0);
  });
});

describe('token entropy', () => {
  it('uses 256 bits', () => {
    expect(SESSION_TOKEN_BYTES).toBe(32);
  });
});
