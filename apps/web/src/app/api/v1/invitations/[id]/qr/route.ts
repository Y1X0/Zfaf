import { getEnv } from '@zfaf/config';
import { can, publicInvitationUrl, tenantScopeFor } from '@zfaf/core';
import { clampQrSize, qrPng, qrSvg } from '@zfaf/infra/qr';

import { container } from '../../../../../../server/container.js';
import { requireActor } from '../../../../../../server/request-context.js';
import { notFound, unauthorized } from '../../../../../../server/responses.js';

/**
 * `GET /api/v1/invitations/{id}/qr?format=svg|png&size=1024` (D6.7, ADR-0016).
 *
 * Owner-scoped even though what it encodes is a public URL. The reason is not
 * the URL's secrecy — anyone holding the link has it already — but that this
 * endpoint takes an invitation *id*. An unauthenticated endpoint keyed on ids
 * is an enumeration oracle: it would answer "published" or "not" for every id
 * anyone cared to try.
 *
 * Generated on demand, locally, deterministically. Nothing is stored, no
 * background job exists, and no third party is told which weddings we host.
 */

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const scope = tenantScopeFor(session.actor);
  if (!scope) return unauthorized();

  const { id } = await context.params;
  const invitation = await container().invitations.findByIdInScope(id, scope);
  if (!invitation) return notFound('Invitation');

  if (
    !can(session.actor, 'invitation:read', {
      kind: 'invitation',
      id: invitation.id,
      ownerId: invitation.ownerId,
    }).allowed
  ) {
    return notFound('Invitation');
  }

  // A code for an unpublished invitation would point at a 404, and the whole
  // hazard of a static code is that it is printed before anyone checks.
  if (invitation.slug === null || invitation.publishedVersionId === null) {
    return notFound('Published invitation');
  }

  const url = publicInvitationUrl(getEnv().PUBLIC_BASE_URL, invitation.slug);
  const params = new URL(request.url).searchParams;
  const format = params.get('format') === 'png' ? 'png' : 'svg';

  // `private`: it belongs to one owner, so no shared cache should hold it.
  const headers = { 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' };

  if (format === 'png') {
    const png = await qrPng(url, clampQrSize(Number(params.get('size') ?? '')));
    return new Response(new Uint8Array(png), {
      headers: {
        ...headers,
        'content-type': 'image/png',
        'content-disposition': `attachment; filename="${invitation.slug}-qr.png"`,
      },
    });
  }

  return new Response(await qrSvg(url), {
    headers: {
      ...headers,
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-disposition': `attachment; filename="${invitation.slug}-qr.svg"`,
    },
  });
}
