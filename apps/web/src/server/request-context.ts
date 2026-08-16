import { createHash } from 'node:crypto';

import { cookies, headers } from 'next/headers';

import { type Actor, SESSION_COOKIE_NAME, resolveSession } from '@zfaf/core';

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
  | { readonly authenticated: true; readonly actor: Actor; readonly ipHash: string }
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

export async function requireActor(): Promise<RequestActor> {
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
    tokens: deps.tokens,
    clock: deps.clock,
  });

  if (!resolved.ok) {
    // The reason is for our logs. What the client is told is uniform — see
    // `unauthorized()` — because distinguishing "expired" from "revoked" from
    // "no such session" tells an attacker which tokens once existed.
    return { authenticated: false, reason: resolved.reason, ipHash };
  }

  return { authenticated: true, actor: resolved.actor, ipHash };
}
