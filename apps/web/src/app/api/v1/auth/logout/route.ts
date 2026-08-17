import { logout, logoutAllSessions } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { requireActorPendingTwoFactor } from '../../../../../server/request-context.js';
import { withClearedSessionCookie } from '../../../../../server/session-cookie.js';
import { ok } from '../../../../../server/responses.js';

/**
 * `POST /api/v1/auth/logout` — sign out (FR-A5).
 *
 * Uses `requireActorPendingTwoFactor`, and that is deliberate: an operator who
 * cannot complete their second-factor challenge — lost phone, wrong
 * authenticator — must still be able to end the session. Refusing to let
 * somebody *leave* until they finish authenticating protects nothing.
 *
 * `?all=true` ends every session (FR-A5, "sign out from every device"). The
 * current one goes with them: a person pressing that button after losing a
 * laptop expects it to mean everywhere.
 *
 * Answers 200 even with no session. There is nothing to reveal, and a client
 * clearing local state should not have to branch on whether the cookie was
 * still valid.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const blocked = requireSameOrigin(request);
  if (blocked) return blocked;

  const session = await requireActorPendingTwoFactor();
  if (!session.authenticated) {
    // Nothing to end. Clear the cookie anyway — the browser may be holding a
    // token the server has already forgotten.
    return withClearedSessionCookie(ok({ signedOut: true, everywhere: false }));
  }

  const everywhere = new URL(request.url).searchParams.get('all') === 'true';
  const actor = session.actor;
  if (actor.kind !== 'user') {
    return withClearedSessionCookie(ok({ signedOut: true, everywhere: false }));
  }

  const deps = container();
  const sessionDeps = {
    users: deps.users,
    sessions: deps.sessions,
    memberships: deps.memberships,
    audit: deps.audit,
    twoFactor: deps.twoFactor,
    tokens: deps.tokens,
    clock: deps.clock,
  };

  if (everywhere) {
    await logoutAllSessions(actor.userId, sessionDeps, { reason: 'user_request' });
  } else {
    await logout(actor.sessionId, actor.userId, sessionDeps);
  }

  return withClearedSessionCookie(ok({ signedOut: true, everywhere }));
}
