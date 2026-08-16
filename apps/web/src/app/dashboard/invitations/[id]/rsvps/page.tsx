import { notFound } from 'next/navigation';

import { can, tenantScopeFor } from '@zfaf/core';

import { RsvpDashboard } from '../../../../../dashboard/RsvpDashboard.js';
import { container } from '../../../../../server/container.js';
import { requireActor } from '../../../../../server/request-context.js';
import '../../../../dashboard.css';

/**
 * The replies page (D7.5).
 *
 * Authorised twice on purpose. The scope decides which invitation this session
 * can see at all, and `can(…, 'rsvp:read')` decides whether this actor may
 * read guest data on it — a distinction that matters because platform staff
 * pass the first check and must fail the second.
 *
 * The rows themselves are fetched by the island rather than embedded here: a
 * guest list is searched and filtered, and each of those is a request the page
 * would otherwise have to re-render for.
 */

export const dynamic = 'force-dynamic';

export default async function RsvpsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const session = await requireActor();
  if (!session.authenticated) notFound();

  const scope = tenantScopeFor(session.actor);
  if (!scope) notFound();

  const { id } = await params;
  const invitation = await container().invitations.findByIdInScope(id, scope);
  // 404 rather than 403 for an invitation that is not this caller's — the same
  // rule the API follows, for the same reason.
  if (!invitation) notFound();

  const allowed = can(session.actor, 'rsvp:read', {
    kind: 'invitation',
    id: invitation.id,
    ownerId: invitation.ownerId,
  });
  // Staff reach this line and stop here: `rsvp:read` is guest data, and guest
  // data is not staff-readable however senior the account (docs/09 §3.4).
  if (!allowed.allowed) notFound();

  return <RsvpDashboard invitationId={invitation.id} title={invitation.title} />;
}
