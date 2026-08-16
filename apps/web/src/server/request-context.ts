import { createHash } from 'node:crypto';

import { cookies, headers } from 'next/headers';

import {
  type Actor,
  SESSION_COOKIE_NAME,
  type TwoFactorGate,
  isStaff,
  resolveSession,
} from '@zfaf/core';

import { container } from './container.js';

/**
 * Turning an HTTP request into an authenticated actor (D2.7, deferred from M2
 * because there was no HTTP layer to put it in until now).
 *
 * The single rule this file exists to enforce: **the actor comes from the
 * session cookie and from nothing else.** Not a header, not a query
 * parameter, not a body field. `resolveSession` loads the user *and their
 * memberships* from the database, which is what makes a forged tenant id
 * detectable — the comparison downstream is against server-side truth
 * (M2, `resolveTenantContext`).
 *
 * There is deliberately no `getActorOrNull()` that route handlers might call
 * and then forget to check. `requireActor` returns a discriminated result, so
 * a handler that ignores the failure case does not compile.
 */

export type RequestActor =
  | {
      readonly authenticated: true;
      readonly actor: Actor;
      readonly ipHash: string;
      /** When this session was created. The admin guard is the only reader. */
      readonly sessionStartedAt: Date;
      /**
       * Whether this session cleared its second factor (docs/09 §2.8).
       *
       * `requireActor` already refuses anything but a satisfied gate, so an
       * ordinary handler never sees an unsatisfied one. It is carried here for
       * the four endpoints that exist to satisfy it, which call
       * `requireActorPendingTwoFactor` instead.
       */
      readonly twoFactor: TwoFactorGate;
    }
  | { readonly authenticated: false; readonly reason: string; readonly ipHash: string };

/**
 * A stable, non-reversible client identifier for rate limiting.
 *
 * Hashed rather than stored raw: an IP address is personal data under most
 * readings, we only ever need equality, and a rate-limit key is not worth
 * keeping a plaintext address for (docs/12 §5).
 */
export async function clientIpHash(): Promise<string> {
  const headerBag = await headers();
  const forwarded = headerBag.get('x-forwarded-for') ?? '';
  // The left-most entry is the client; everything after it is our own proxies.
  const address = forwarded.split(',')[0]?.trim() || headerBag.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(address).digest('hex').slice(0, 32);
}

/**
 * Resolves the session **without** applying the second-factor gate.
 *
 * Exported narrowly and named awkwardly on purpose. Only the endpoints that
 * exist to *satisfy* the gate may use it — enrollment, confirmation, the
 * challenge, the status read and signing out — and the awkward name is there so
 * that a handler reaching for it stands out in review.
 */
export async function requireActorPendingTwoFactor(): Promise<RequestActor> {
  const ipHash = await clientIpHash();
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value ?? null;

  if (!token) {
    return { authenticated: false, reason: 'NO_SESSION', ipHash };
  }

  const deps = container();
  const resolved = await resolveSession(token, {
    users: deps.users,
    sessions: deps.sessions,
    memberships: deps.memberships,
    audit: deps.audit,
    twoFactor: deps.twoFactor,
    tokens: deps.tokens,
    clock: deps.clock,
  });

  if (!resolved.ok) {
    // The reason is for our logs. What the client is told is uniform — see
    // `unauthorized()` — because distinguishing "expired" from "revoked" from
    // "no such session" tells an attacker which tokens once existed.
    return { authenticated: false, reason: resolved.reason, ipHash };
  }

  return {
    authenticated: true,
    actor: resolved.actor,
    ipHash,
    sessionStartedAt: resolved.sessionStartedAt,
    twoFactor: resolved.twoFactor,
  };
}

/**
 * The authenticated actor for an ordinary request.
 *
 * The second-factor gate is applied **here**, not per route. That placement is
 * the whole design: a per-route check is a list somebody has to remember to
 * extend, and the one entry point that gets forgotten is the entirety of the
 * protection. A session that owes a challenge is simply not authenticated, and
 * every handler that already handles `authenticated: false` handles this too
 * without knowing it exists.
 */
export async function requireActor(): Promise<RequestActor> {
  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) return session;

  if (session.twoFactor.state === 'ENROLLMENT_REQUIRED') {
    return {
      authenticated: false,
      reason: 'TWO_FACTOR_ENROLLMENT_REQUIRED',
      ipHash: session.ipHash,
    };
  }
  if (session.twoFactor.state === 'CHALLENGE_REQUIRED') {
    return { authenticated: false, reason: 'TWO_FACTOR_REQUIRED', ipHash: session.ipHash };
  }

  return session;
}

/**
 * How recently an operator must have signed in to use the admin console.
 *
 * From docs/04 §10. A session is extended as it is used, so a support laptop
 * left open for three weeks holds a perfectly valid one — valid, but no longer
 * evidence that the person at the keyboard is the person who authenticated.
 * Four hours is roughly a shift.
 */
export const ADMIN_SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export type AdminGate =
  | { readonly ok: true; readonly actor: Actor; readonly ipHash: string }
  | { readonly ok: false; readonly reason: 'UNAUTHENTICATED' | 'NOT_STAFF' | 'SESSION_TOO_OLD' };

/**
 * The gate every `/api/admin/*` route and every `/admin` page passes through.
 *
 * Three checks, and the order matters only for what the caller is told: an
 * anonymous visitor and a signed-in customer both get the same 404 upstream,
 * because confirming that an admin console exists at this path is information
 * a stranger has no use for. The distinction returned here is for the route to
 * log, not to publish.
 *
 * **Two-factor authentication is enforced** (docs/09 §2.8, M10). Not here,
 * though — `requireActor` refuses a session that owes a challenge before this
 * function ever runs, so an unverified staff session reaches this as
 * `UNAUTHENTICATED`. Putting the check in the shared path rather than in this
 * one gate is what makes "every admin entry point" true by construction rather
 * than by an inventory of entry points.
 */
export async function requireAdmin(): Promise<AdminGate> {
  const session = await requireActor();
  if (!session.authenticated) return { ok: false, reason: 'UNAUTHENTICATED' };

  const actor = session.actor;
  if (actor.kind !== 'user' || !isStaff(actor)) return { ok: false, reason: 'NOT_STAFF' };

  const age = Date.now() - session.sessionStartedAt.getTime();
  if (age > ADMIN_SESSION_MAX_AGE_MS) return { ok: false, reason: 'SESSION_TOO_OLD' };

  return { ok: true, actor, ipHash: session.ipHash };
}
