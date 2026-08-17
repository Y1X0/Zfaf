import { resendVerification, verifyEmail } from '@zfaf/core';

import { authDependencies, readAuthBody, readString } from '../../../../../server/auth.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { requireActorPendingTwoFactor } from '../../../../../server/request-context.js';
import { badRequest, ok, unauthorized } from '../../../../../server/responses.js';

/**
 * Email verification (FR-A2).
 *
 * - `POST` — redeem a token from the email.
 * - `PUT`  — ask for another one.
 *
 * **`POST`, not `GET`, and the link in the email must not be the endpoint.**
 * docs/09 §5 is explicit: no mutating operation over `GET`, because
 * `SameSite=Lax` lets a cross-site `GET` carry the cookie. A verification link
 * is also followed by mail scanners, corporate proxies and link previewers —
 * all of which would silently consume a single-use token before the person
 * ever clicked. The email points at a page; the page posts here.
 *
 * Verification grants exactly one capability: the ability to publish. It never
 * touches a role. A verification link that could escalate privilege would make
 * every inbox a path to admin.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const body = await readAuthBody(request);
  const token = body ? readString(body, 'token', 512) : null;
  if (!token) return badRequest('VALIDATION_FAILED', 'A verification token is required');

  const result = await verifyEmail(token, authDependencies());
  if (!result.ok) {
    // One answer for expired, already used, and never existed. Distinguishing
    // them tells a caller which tokens were once real.
    return badRequest('VALIDATION_FAILED', 'That link is no longer valid');
  }

  return ok({ verified: true });
}

export async function PUT(request: Request): Promise<Response> {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated || session.actor.kind !== 'user') {
    // 401, not 400: this is an authorization refusal, and saying so is what
    // lets the generated authorization matrix mean anything. Resending needs a
    // session rather than an address — an endpoint that took an email would
    // send mail to anyone, at anyone's request.
    return unauthorized();
  }

  // Rate limited in the use case, and answers the same way whether or not a
  // mail was actually sent — the address may already be verified.
  await resendVerification(session.actor.userId, authDependencies());
  return ok({ requested: true });
}
