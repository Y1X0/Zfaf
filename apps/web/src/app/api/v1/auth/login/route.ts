import { login } from '@zfaf/core';

import {
  authDependencies,
  authFailure,
  readAuthBody,
  readString,
} from '../../../../../server/auth.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { clientIpHash } from '../../../../../server/request-context.js';
import { withSessionCookie } from '../../../../../server/session-cookie.js';
import { badRequest, ok } from '../../../../../server/responses.js';
import { container } from '../../../../../server/container.js';

/**
 * `POST /api/v1/auth/login` — sign in (FR-A1).
 *
 * ## The second factor
 *
 * A staff account's session is issued here and is **deliberately useless**
 * until `/api/v1/auth/two-factor/verify` answers its challenge: session
 * resolution refuses an unverified staff session everywhere except the five
 * endpoints that exist to satisfy the gate (docs/09 §2.8). So this handler does
 * not branch on 2FA to *decide* anything — it only tells the client which
 * screen to show next.
 *
 * That ordering matters. Issuing the cookie first and gating on use, rather
 * than holding a separate "pending" credential, means there is exactly one kind
 * of session in the system and one place that decides what it may do.
 *
 * ## What the response never says
 *
 * Whether the address exists, whether the password was close, whether the
 * account is suspended, or whether it is OAuth-only. All four produce the same
 * 401 with the same body.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const body = await readAuthBody(request);
  if (!body) return badRequest('VALIDATION_FAILED', 'Check the submitted values');

  const email = readString(body, 'email');
  const password = readString(body, 'password', 256);
  if (!email || !password) {
    return badRequest('VALIDATION_FAILED', 'An email address and a password are required');
  }

  const result = await login(
    {
      email,
      password,
      ipHash: await clientIpHash(),
      userAgent: request.headers.get('user-agent'),
    },
    authDependencies(),
  );

  if (!result.ok) return authFailure(result.error.code);

  const user = await container().users.findById(result.value.userId);
  const credential = await container().twoFactor.findByUserId(result.value.userId);
  const enrolled = credential?.confirmedAt != null;
  const staff = user ? user.role !== 'customer' && user.role !== 'planner' : false;

  const response = ok({
    // Never the user id, and never the role beyond what the client must render.
    requiresEmailVerification: result.value.requiresEmailVerification,
    deletionCancelled: result.value.deletionCancelled,
    /**
     * What the client should do next.
     *
     * `enrol` for a staff account with no factor, `challenge` for one that has
     * it, `none` otherwise. This is a rendering hint, not a permission: the
     * session already carries exactly the authority it is entitled to, and
     * lying about this value gains a caller nothing.
     */
    nextStep: staff && !enrolled ? 'enrol_two_factor' : enrolled ? 'two_factor' : 'none',
  });

  return withSessionCookie(response, result.value.sessionToken, { isStaff: staff });
}
