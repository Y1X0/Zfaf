import { deleteInvitation, tenantScopeFor } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { requireActor } from '../../../../../server/request-context.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { notFound, ok, unauthorized } from '../../../../../server/responses.js';

/**
 * `GET /api/v1/invitations/{id}` — the document the builder opens with.
 *
 * Returns the draft and its version together, because the version is what
 * every subsequent autosave is built on. Splitting them across two calls would
 * open a window in which the client holds a document from one version and a
 * number from another.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const scope = tenantScopeFor(session.actor);
  if (!scope) return unauthorized();

  const { id } = await context.params;
  const invitation = await container().invitations.findByIdInScope(id, scope);

  // 404 for "not yours" as well as "does not exist" — a 403 here would confirm
  // the id is real and turn this into an enumeration oracle.
  if (!invitation) return notFound('Invitation');

  return ok({
    id: invitation.id,
    title: invitation.title,
    slug: invitation.slug,
    status: invitation.status,
    locale: invitation.locale,
    timezone: invitation.timezone,
    document: invitation.draftDocument,
    version: invitation.draftVersion,
    // Drives the "you have unpublished changes" bar (docs/06 §8).
    publishedAt: invitation.publishedAt?.toISOString() ?? null,
    hasPublishedVersion: invitation.publishedVersionId !== null,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const scope = tenantScopeFor(session.actor);
  if (!scope) return unauthorized();

  const { id } = await context.params;
  const deps = container();

  const invitation = await deps.invitations.findByIdInScope(id, scope);
  if (!invitation) return notFound('Invitation');

  const result = await deleteInvitation(
    {
      actor: session.actor,
      invitationId: id,
      invitationOwnerId: invitation.ownerId,
    },
    {
      repository: deps.invitations,
      clock: deps.clock,
    },
  );

  if (!result.ok) {
    if (result.code === 'NOT_FOUND') {
      return notFound('Invitation');
    }
    return new Response(JSON.stringify({ code: result.code, message: result.message }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  return ok({ invitationId: id });
}
