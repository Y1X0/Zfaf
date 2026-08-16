import { rsvpStats } from '@zfaf/core';

import { container } from '../../../../../../../server/container.js';
import { requireActor } from '../../../../../../../server/request-context.js';
import { forbidden, notFound, ok, unauthorized } from '../../../../../../../server/responses.js';

/**
 * `GET /api/v1/invitations/{id}/rsvps/stats` — the headline numbers (D7.5).
 *
 * Aggregated from the responses themselves rather than read off the
 * denormalised counters on the invitation. The counters exist to be cheap on
 * the public page; this is the list the couple caters from, where being right
 * matters more than being fast — and computing it independently is also what
 * would reveal a counter that had drifted.
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
  const result = await rsvpStats(
    { actor: session.actor, invitationId: id },
    { invitations: container().invitations, rsvps: container().rsvps },
  );

  if (!result.ok) {
    return result.code === 'FORBIDDEN' ? forbidden('Not permitted') : notFound('Invitation');
  }
  return ok(result.stats);
}
