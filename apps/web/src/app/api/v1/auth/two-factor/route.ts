import {
  beginTwoFactorEnrollment,
  confirmTwoFactorEnrollment,
  disableTwoFactor,
  twoFactorStatus,
} from '@zfaf/core';

import { requireActorPendingTwoFactor } from '../../../../../server/request-context.js';
import { twoFactorDependencies } from '../../../../../server/two-factor.js';
import { badRequest, failure, ok, unauthorized } from '../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../server/origin.js';

/**
 * `/api/v1/auth/two-factor` — enrollment (docs/09 §2.8).
 *
 * These are three of the five endpoints permitted to run before the second
 * factor is satisfied, so they call `requireActorPendingTwoFactor` rather than
 * `requireActor`. That is a deliberate, visible exception; everything else in
 * the application uses the guarded call and gets the gate for free.
 *
 * - `GET`    — status. Whether a factor is required, enrolled, and satisfied.
 * - `POST`   — begin enrollment. Returns a secret that does not work yet.
 * - `PUT`    — confirm with a code from the authenticator. Returns the recovery
 *              codes, once, and never again.
 * - `DELETE` — remove. Refused for staff, where it is mandatory.
 *
 * Nothing here is cached, and nothing here is logged with a code in it.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(): Promise<Response> {
  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) return unauthorized();

  const status = await twoFactorStatus(
    session.actor,
    session.twoFactor.state === 'SATISFIED' ? new Date() : null,
    twoFactorDependencies(),
  );
  if (!status) return unauthorized();

  return ok(status, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) return unauthorized();

  const result = await beginTwoFactorEnrollment(session.actor, twoFactorDependencies());
  if (!result.ok) return fromDomainError(result.error.code);

  /**
   * The secret leaves the server exactly here and nowhere else.
   *
   * `no-store` matters more than usual: a cached enrollment response is a
   * plaintext TOTP secret sitting in a shared proxy.
   */
  return ok(result.value, { headers: NO_STORE });
}

export async function PUT(request: Request): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) return unauthorized();

  const code = await readCode(request);
  if (code === null) return badRequest('VALIDATION_FAILED', 'A code is required');

  const result = await confirmTwoFactorEnrollment(session.actor, code, twoFactorDependencies());
  if (!result.ok) return fromDomainError(result.error.code);

  return ok(result.value, { headers: NO_STORE });
}

export async function DELETE(request: Request): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) return unauthorized();

  const code = await readCode(request);
  if (code === null) return badRequest('VALIDATION_FAILED', 'A code is required');

  const result = await disableTwoFactor(session.actor, code, twoFactorDependencies());
  if (!result.ok) return fromDomainError(result.error.code);

  return ok({ enrolled: false }, { headers: NO_STORE });
}

/**
 * Reads the submitted code.
 *
 * Bounded before parsing: a code is at most a dozen characters, and accepting
 * a megabyte of JSON to find that out is work an unauthenticated-ish endpoint
 * should not do.
 */
async function readCode(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 512) return null;
    body = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null) return null;
  const code = (body as Record<string, unknown>)['code'];
  if (typeof code !== 'string' || code.length === 0 || code.length > 32) return null;
  return code;
}

/**
 * Maps a domain code to a status.
 *
 * `UNAUTHENTICATED` is 401 with the same body a wrong password gets: the
 * response must not distinguish "wrong TOTP" from "wrong recovery code" from
 * "the recovery code was already spent", because each distinction is a hint.
 */
function fromDomainError(code: string): Response {
  switch (code) {
    case 'RATE_LIMITED':
      return failure(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
    case 'CONFLICT':
      return failure(409, 'CONFLICT', 'Two-factor authentication is not in the expected state');
    case 'FORBIDDEN':
      return failure(403, 'FORBIDDEN', 'Not permitted');
    case 'DEPENDENCY_UNAVAILABLE':
      return failure(503, 'DEPENDENCY_UNAVAILABLE', 'Two-factor authentication is unavailable');
    default:
      return unauthorized();
  }
}
