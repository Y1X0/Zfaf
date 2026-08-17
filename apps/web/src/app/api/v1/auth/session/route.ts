import { twoFactorStatus } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { requireActorPendingTwoFactor } from '../../../../../server/request-context.js';
import { twoFactorDependencies } from '../../../../../server/two-factor.js';
import { ok, unauthorized } from '../../../../../server/responses.js';

/**
 * `GET /api/v1/auth/session` — who am I (D2.7).
 *
 * What a client needs to render a signed-in shell, and nothing beyond it.
 * Notably absent: the user id, the session id, any token material, the email
 * verification token, and the membership list. A client that needs to know
 * whether it may edit an invitation asks about *that invitation*; handing it a
 * capability list here would create a second source of truth for authorization
 * that could drift from `can()`.
 *
 * Reachable before the second factor is satisfied, because a client that cannot
 * read the session state cannot render the challenge screen.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) return unauthorized();

  const actor = session.actor;
  if (actor.kind !== 'user') return unauthorized();

  const user = await container().users.findById(actor.userId);
  if (!user) return unauthorized();

  const status = await twoFactorStatus(
    actor,
    session.twoFactor.state === 'SATISFIED' ? new Date() : null,
    twoFactorDependencies(),
  );

  return ok(
    {
      email: user.email,
      name: user.name,
      locale: user.locale,
      role: user.role,
      emailVerified: user.emailVerifiedAt !== null,
      twoFactor: {
        enrolled: status?.enrolled ?? false,
        required: status?.mandatory ?? false,
        // The gate, so a client knows whether to show the challenge screen.
        gate: session.twoFactor.state,
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
