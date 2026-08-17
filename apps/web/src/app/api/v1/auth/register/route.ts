import { registerUser } from '@zfaf/core';

import {
  authDependencies,
  authFailure,
  defaultMarket,
  readAuthBody,
  readString,
} from '../../../../../server/auth.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { clientIpHash } from '../../../../../server/request-context.js';
import { withSessionCookie } from '../../../../../server/session-cookie.js';
import { badRequest, created } from '../../../../../server/responses.js';

/**
 * `POST /api/v1/auth/register` — create an account (FR-A1, FR-A2).
 *
 * **The response is identical whether or not the address was already taken.**
 * That is the whole shape of this handler, and it is why it returns `created`
 * in both cases with a body carrying no user id. An endpoint that answered
 * differently would be a service for discovering which addresses have accounts
 * — and the domain layer burns a password hash on the taken path so the
 * *timing* matches too.
 *
 * The person who already has an account learns about the attempt by email,
 * which is where that information belongs.
 *
 * Verification gates **publishing**, not the first run (FR-A2): a new user
 * reaches a finished draft before being asked for anything, so the session is
 * issued here rather than withheld until they check their inbox.
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

  const name = readString(body, 'name', 120);
  const locale = body['locale'] === 'en' ? 'en' : 'ar';

  const result = await registerUser(
    {
      email,
      password,
      name,
      locale,
      marketCode: defaultMarket(),
      ipHash: await clientIpHash(),
      userAgent: request.headers.get('user-agent'),
    },
    authDependencies(),
  );

  if (!result.ok) {
    return authFailure(result.error.code, result.error.details);
  }

  /**
   * One body for both outcomes.
   *
   * `created: false` is never sent — the caller cannot be told which path they
   * took. The cookie is the only observable difference, and a caller who did
   * not create an account has no session to observe.
   */
  const response = created({ registered: true });
  if (result.value.sessionToken) {
    // A brand-new account is never staff, so the customer TTL is correct here.
    return withSessionCookie(response, result.value.sessionToken, { isStaff: false });
  }
  return response;
}
