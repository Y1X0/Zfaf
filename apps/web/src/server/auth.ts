import { getEnv } from '@zfaf/config';
import { type AuthDependencies, type PasswordHasher, isStaff } from '@zfaf/core';
// Constructed here rather than in the composition root, and the reason is a
// build constraint rather than taste: `@node-rs/argon2` is a native `.node`
// binary that webpack cannot parse, and the container is imported by every
// route — including `/i/[slug]`, which has no use for a password hasher. Kept
// in this module, the binding enters only the graphs of the routes that
// actually verify a password.
import { Argon2PasswordHasher } from '@zfaf/infra/crypto/password';

import { container } from './container.js';
import { badRequest, failure } from './responses.js';

/** One instance per process: Argon2 holds tuned parameters, not per-call state. */
let hasher: PasswordHasher | null = null;

/**
 * The dependency bundle and shared shapes for the authentication endpoints.
 *
 * Assembled once, as `twoFactorDependencies` is, so no handler can quietly hand
 * in a different hasher or rate limiter.
 */
export function authDependencies(): AuthDependencies {
  const deps = container();
  return {
    users: deps.users,
    sessions: deps.sessions,
    verificationTokens: deps.verificationTokens,
    audit: deps.audit,
    hasher: (hasher ??= new Argon2PasswordHasher()),
    tokens: deps.tokens,
    rateLimiter: deps.rateLimiter,
    mail: deps.mail,
    clock: deps.clock,
    ids: deps.ids,
  };
}

/** Which market a new account belongs to, when the request does not say. */
export function defaultMarket(): string {
  return getEnv().DEFAULT_MARKET;
}

export function staffRole(role: string): boolean {
  return isStaff({ kind: 'user', role } as Parameters<typeof isStaff>[0]);
}

/**
 * Reads a JSON body, bounded before parsing.
 *
 * These endpoints are reachable without a session, so they must not be willing
 * to buffer a megabyte to discover a field is missing.
 */
export async function readAuthBody(
  request: Request,
  maxBytes = 4096,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 320,
): string | null {
  const value = body[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Maps a domain failure to a response.
 *
 * `UNAUTHENTICATED` is deliberately uniform. A wrong password, an unknown
 * address, a suspended account and an OAuth-only account all produce the same
 * body and the same status, because any difference between them turns sign-in
 * into a service for discovering which addresses have accounts — and the domain
 * layer already pays a hash to make the *timing* uniform too.
 */
export function authFailure(code: string, details?: unknown): Response {
  switch (code) {
    case 'RATE_LIMITED':
      return failure(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
    case 'VALIDATION_FAILED':
      return badRequest('VALIDATION_FAILED', 'Check the submitted values', details);
    default:
      return failure(401, 'UNAUTHENTICATED', 'Those details did not match an account');
  }
}
