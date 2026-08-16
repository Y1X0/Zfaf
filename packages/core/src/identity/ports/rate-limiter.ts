/**
 * Rate limiting port (docs/09-auth-and-rbac.md §2.4).
 *
 * Declared in the domain because limits are a business rule — "five attempts
 * per fifteen minutes" is a product decision — while the counting mechanism is
 * infrastructure.
 */

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
  /** Present when denied, for the Retry-After header. */
  readonly retryAfterSeconds?: number;
}

export interface RateLimiter {
  /** Records an attempt and reports whether it is permitted. */
  consume(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitVerdict>;
  /** Clears a key — used after a successful sign-in, so one success forgives earlier failures. */
  reset(key: string): Promise<void>;
  peek(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitVerdict>;
}

/**
 * The limits themselves.
 *
 * Layered on purpose: a per-account limit alone lets an attacker spread guesses
 * across many accounts (credential stuffing), and a per-IP limit alone lets a
 * distributed attacker focus on one account.
 */
export const RATE_LIMITS = {
  loginPerAccount: { limit: 5, windowMs: 15 * 60 * 1000 },
  loginPerIp: { limit: 20, windowMs: 60 * 60 * 1000 },
  registerPerIp: { limit: 3, windowMs: 60 * 60 * 1000 },
  passwordResetPerAccount: { limit: 3, windowMs: 60 * 60 * 1000 },
  passwordResetPerIp: { limit: 5, windowMs: 60 * 60 * 1000 },
  verificationResendPerAccount: { limit: 2, windowMs: 60 * 60 * 1000 },

  /**
   * Second-factor guessing (docs/09 §2.8).
   *
   * A six-digit code is a million possibilities, and the ±1-step window makes
   * three of them valid at any instant — so an unthrottled endpoint falls to
   * roughly 333,000 requests, which is minutes of scripted traffic. These
   * limits are what turn that into years.
   *
   * Per session **and** per account, layered for the same reason sign-in is: a
   * per-session limit alone is defeated by signing in again for a fresh
   * session, and only the per-account limit sees that.
   */
  twoFactorPerSession: { limit: 5, windowMs: 5 * 60 * 1000 },
  twoFactorPerAccount: { limit: 10, windowMs: 15 * 60 * 1000 },
  twoFactorPerIp: { limit: 30, windowMs: 60 * 60 * 1000 },
} as const;

/**
 * Progressive lockout after repeated failures on one account.
 *
 * Escalating rather than fixed: a person who mistypes twice should not be
 * locked out for an hour, while an automated attacker hits growing delays.
 */
export const LOCKOUT_LADDER_MS: readonly number[] = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
];

export function lockoutDurationFor(consecutiveFailures: number): number | null {
  if (consecutiveFailures < 5) return null;
  const step = Math.min(consecutiveFailures - 5, LOCKOUT_LADDER_MS.length - 1);
  return LOCKOUT_LADDER_MS[step] ?? null;
}
