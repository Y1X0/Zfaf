import { verifyTwoFactorChallenge } from '@zfaf/core';

import { requireActorPendingTwoFactor } from '../../../../../../server/request-context.js';
import { twoFactorDependencies } from '../../../../../../server/two-factor.js';
import { badRequest, failure, ok, unauthorized } from '../../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../../server/origin.js';

/**
 * `POST /api/v1/auth/two-factor/verify` — the login challenge (docs/09 §2.8).
 *
 * The second half of signing in for anyone who holds a second factor. The
 * session cookie already exists at this point and is deliberately useless: an
 * unverified session is not authenticated anywhere else in the application, so
 * a stolen cookie taken before this call buys nothing.
 *
 * Accepts a TOTP code or a recovery code, and answers identically when either
 * is wrong. The response never says which kind it was expecting, and never
 * says whether a recovery code was unknown or already spent.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) return unauthorized();

  // Already satisfied: answer without consuming a code, and without consuming
  // an attempt from the rate-limit budget. A double-submitted form must not
  // burn one of five tries.
  if (session.twoFactor.state === 'SATISFIED' || session.twoFactor.state === 'NOT_REQUIRED') {
    return ok({ verified: true }, { headers: { 'cache-control': 'no-store' } });
  }

  let code: string;
  try {
    const text = await request.text();
    if (text.length > 512) return badRequest('VALIDATION_FAILED', 'A code is required');
    const body = JSON.parse(text) as Record<string, unknown>;
    const candidate = body['code'];
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 32) {
      return badRequest('VALIDATION_FAILED', 'A code is required');
    }
    code = candidate;
  } catch {
    return badRequest('VALIDATION_FAILED', 'A code is required');
  }

  const result = await verifyTwoFactorChallenge(session.actor, code, twoFactorDependencies());

  if (!result.ok) {
    if (result.error.code === 'RATE_LIMITED') {
      return failure(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.');
    }
    if (result.error.code === 'DEPENDENCY_UNAVAILABLE') {
      return failure(503, 'DEPENDENCY_UNAVAILABLE', 'Two-factor authentication is unavailable');
    }
    // Everything else — wrong code, replayed code, spent recovery code, no
    // enrollment — is one answer.
    return unauthorized();
  }

  return ok(
    {
      verified: true,
      method: result.value.method,
      recoveryCodesRemaining: result.value.recoveryCodesRemaining,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
