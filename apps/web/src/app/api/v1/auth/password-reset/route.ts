import { requestPasswordReset, resetPassword } from '@zfaf/core';

import {
  authDependencies,
  authFailure,
  readAuthBody,
  readString,
} from '../../../../../server/auth.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { clientIpHash } from '../../../../../server/request-context.js';
import { withClearedSessionCookie } from '../../../../../server/session-cookie.js';
import { badRequest, ok } from '../../../../../server/responses.js';

/**
 * Password reset (FR-A4).
 *
 * - `POST` — ask for a link.
 * - `PUT`  — set a new password with the token from it.
 *
 * ## `POST` always answers 200
 *
 * Whether or not the address has an account. This endpoint is the classic
 * account-enumeration oracle: an attacker with a list of addresses learns which
 * ones are customers simply by watching which requests differ. So the response
 * is fixed, and the use case does the work that keeps the *timing* fixed too.
 *
 * ## `PUT` ends every session
 *
 * Including the one making the request — which is why the cookie is cleared
 * here. If the reset was triggered by an attacker who already had a session,
 * leaving it alive would defeat the entire exercise; and a person resetting
 * their password after a scare expects exactly this.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const body = await readAuthBody(request);
  const email = body ? readString(body, 'email') : null;
  if (!email) return badRequest('VALIDATION_FAILED', 'An email address is required');

  const result = await requestPasswordReset(
    { email, ipHash: await clientIpHash() },
    authDependencies(),
  );

  // Rate limiting is the one thing that may be reported, because it is about
  // the caller rather than about the account.
  if (!result.ok && result.error.code === 'RATE_LIMITED') {
    return authFailure('RATE_LIMITED');
  }

  // Otherwise: the same answer, always. "If that address has an account, a
  // link is on its way."
  return ok({ requested: true });
}

export async function PUT(request: Request): Promise<Response> {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const body = await readAuthBody(request);
  if (!body) return badRequest('VALIDATION_FAILED', 'Check the submitted values');

  const token = readString(body, 'token', 512);
  const password = readString(body, 'password', 256);
  if (!token || !password) {
    return badRequest('VALIDATION_FAILED', 'A token and a new password are required');
  }

  const result = await resetPassword({ token, newPassword: password }, authDependencies());
  if (!result.ok) {
    if (result.error.code === 'RATE_LIMITED') return authFailure('RATE_LIMITED');

    /**
     * Two different failures, told apart — because the person can act on the
     * difference and neither answer reveals anything.
     *
     * The domain returns `VALIDATION_FAILED` for both a weak password and a
     * stale token, and collapsing them was a real usability defect: somebody
     * whose link had expired was told to "check the submitted values" and
     * retyped their password until they gave up. The token is a secret they
     * hold, not an identifier — saying it is no longer valid tells an attacker
     * only what they already knew about a token they invented.
     *
     * The password complaint is distinguished by carrying `details`.
     */
    const aboutPassword = result.error.details?.some((detail) => detail.field === 'password');
    if (aboutPassword) {
      return authFailure('VALIDATION_FAILED', result.error.details);
    }
    return badRequest(
      'RESET_LINK_INVALID',
      'That reset link has expired or has already been used. Request a new one.',
    );
  }

  return withClearedSessionCookie(ok({ reset: true, sessionsEnded: result.sessionsRevoked }));
}
