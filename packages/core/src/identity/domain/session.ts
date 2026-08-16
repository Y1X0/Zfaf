/**
 * Session lifecycle (ADR-0006).
 *
 * The token the browser holds is opaque and carries no information. The server
 * stores only `sha256(token)`, so a read-only database leak yields no usable
 * sessions — the property that justified database sessions over JWT in the
 * first place, and the reason Auth.js's adapter could not be used (ADR-0018).
 */

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly userAgent: string | null;
}

/** Customer sessions: long enough to be convenient, bounded absolutely. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** No session outlives this, however actively it is used. */
export const SESSION_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Staff sessions expire in hours, not weeks. A staff account reaches far more
 * data, so the window in which a stolen session is useful must be small
 * (docs/09 §7).
 */
export const STAFF_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** Sliding extension only kicks in after this much idle time, to avoid a write per request. */
export const SESSION_SLIDING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Entropy for the opaque token. 256 bits is far beyond guessing range. */
export const SESSION_TOKEN_BYTES = 32;

export type SessionRejection = 'NOT_FOUND' | 'EXPIRED' | 'REVOKED' | 'ABSOLUTE_LIFETIME_EXCEEDED';

export type SessionValidity =
  | { readonly valid: true; readonly shouldExtend: boolean; readonly newExpiresAt: Date | null }
  | { readonly valid: false; readonly reason: SessionRejection };

export function sessionTtlFor(isStaff: boolean): number {
  return isStaff ? STAFF_SESSION_TTL_MS : SESSION_TTL_MS;
}

/**
 * Evaluates a stored session against the clock.
 *
 * Pure, so every branch — expired, revoked, past the absolute cap, due for a
 * sliding extension — is a unit test rather than something only observable by
 * waiting a month.
 */
export function evaluateSession(
  session: SessionRecord | null,
  now: Date,
  options: { isStaff?: boolean } = {},
): SessionValidity {
  if (!session) return { valid: false, reason: 'NOT_FOUND' };
  if (session.revokedAt !== null) return { valid: false, reason: 'REVOKED' };
  if (session.expiresAt.getTime() <= now.getTime()) return { valid: false, reason: 'EXPIRED' };

  // The absolute cap is checked independently of expiry: sliding extension must
  // never be able to keep one session alive indefinitely.
  if (now.getTime() - session.createdAt.getTime() > SESSION_ABSOLUTE_MAX_MS) {
    return { valid: false, reason: 'ABSOLUTE_LIFETIME_EXCEEDED' };
  }

  const idleMs = now.getTime() - session.lastUsedAt.getTime();
  const shouldExtend = idleMs >= SESSION_SLIDING_THRESHOLD_MS;

  if (!shouldExtend) return { valid: true, shouldExtend: false, newExpiresAt: null };

  const ttl = sessionTtlFor(options.isStaff === true);
  const proposed = new Date(now.getTime() + ttl);
  const absoluteLimit = new Date(session.createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS);
  const capped = proposed.getTime() > absoluteLimit.getTime() ? absoluteLimit : proposed;

  return { valid: true, shouldExtend: true, newExpiresAt: capped };
}

/**
 * Cookie attributes for the session cookie.
 *
 * The `__Host-` prefix is not decoration: it forces `Secure` and `Path=/` and
 * forbids a `Domain`, which stops a compromised subdomain from planting a
 * session cookie on the apex.
 */
export const SESSION_COOKIE_NAME = '__Host-zfaf_session';

export interface SessionCookieAttributes {
  readonly name: string;
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'lax';
  readonly path: '/';
  readonly maxAgeSeconds: number;
}

export function sessionCookieAttributes(isStaff: boolean): SessionCookieAttributes {
  return {
    name: SESSION_COOKIE_NAME,
    // Unreadable from JavaScript, so an XSS bug cannot exfiltrate the session.
    httpOnly: true,
    secure: true,
    // Lax, not Strict: Strict would break a user arriving from the verification
    // email, which is a normal path. CSRF is additionally covered by an Origin
    // check on every mutating request (docs/09 §5).
    sameSite: 'lax',
    path: '/',
    maxAgeSeconds: Math.floor(sessionTtlFor(isStaff) / 1000),
  };
}

/** Attributes that clear the cookie on sign-out. */
export function clearedSessionCookieAttributes(): SessionCookieAttributes {
  return { ...sessionCookieAttributes(false), maxAgeSeconds: 0 };
}
