import { deleteRsvp } from '@zfaf/core';

import { container } from '../../../../../../../server/container.js';
import { requireActor } from '../../../../../../../server/request-context.js';
import { forbidden, notFound, ok, unauthorized } from '../../../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../../../server/origin.js';

/**
 * `DELETE /api/v1/invitations/{id}/rsvps/{rsvpId}` — removing a reply (D7.5).
 *
 * A hard delete, and the counters move with it in the same transaction. This
 * is a guest's personal data that the couple has chosen to remove; keeping a
 * hidden copy would make the deletion a lie, and leaving the counter behind
 * would make the guest list disagree with itself.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; rsvpId: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const { id, rsvpId } = await context.params;
  const deps = container();

  const result = await deleteRsvp(
    { actor: session.actor, invitationId: id, rsvpId },
    { invitations: deps.invitations, rsvps: deps.rsvps, clock: deps.clock },
  );

  if (!result.ok) {
    return result.code === 'FORBIDDEN' ? forbidden('Not permitted') : notFound('Response');
  }
  return ok({ deleted: true });
}
