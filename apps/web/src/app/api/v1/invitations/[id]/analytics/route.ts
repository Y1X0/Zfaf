import { invitationStatsPanel } from '@zfaf/core';

import { container } from '../../../../../../server/container.js';
import { requireActor } from '../../../../../../server/request-context.js';
import { forbidden, notFound, ok, unauthorized } from '../../../../../../server/responses.js';

/**
 * `GET /api/v1/invitations/{id}/analytics` — the couple's stats panel (D8.4).
 *
 * Four figures: views, unique visitors, replies, and which kind of device
 * people opened the invitation on. No countries, no referrers, no time series
 * — all deferred by the owner (ADR-0009 amendment), and the endpoint does not
 * accept `from`, `to` or `granularity` parameters, because accepting them and
 * ignoring them would suggest a range filter that does not exist.
 *
 * The numbers can lag reality by up to a minute: views are buffered and
 * flushed on a timer (D8.3). That is a deliberate trade for keeping the public
 * page off the primary database during a burst, and it is stated in the panel
 * rather than hidden.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const { id } = await context.params;
  const deps = container();

  const result = await invitationStatsPanel(
    { actor: session.actor, invitationId: id },
    { invitations: deps.invitations, analytics: deps.analytics, rsvps: deps.rsvps },
  );

  if (!result.ok) {
    return result.code === 'FORBIDDEN' ? forbidden('Not permitted') : notFound('Invitation');
  }

  return ok(result.panel, {
    // Somebody's private numbers. A shared cache has no business holding them,
    // and they change every minute anyway.
    headers: { 'cache-control': 'private, no-store' },
  });
}
