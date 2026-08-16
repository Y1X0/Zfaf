import { listRsvps } from '@zfaf/core';

import { container } from '../../../../../../server/container.js';
import { requireActor } from '../../../../../../server/request-context.js';
import { forbidden, notFound, ok, unauthorized } from '../../../../../../server/responses.js';

/**
 * `GET /api/v1/invitations/{id}/rsvps` — the couple's list of replies (D7.5).
 *
 * The most sensitive read in the product: real names and phone numbers of
 * people who never signed up for anything. Two consequences, both enforced
 * below rather than described:
 *
 *   • It is authorised as `rsvp:read`, which `can()` treats as **guest data**
 *     — the one category platform staff may never read, however senior. A
 *     support agent can fix a broken link without knowing who is attending
 *     somebody's wedding.
 *   • The repository refuses to return a row without a `TenantScope`, so a
 *     handler that forgot its check still cannot leak another couple's list.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const { id } = await context.params;
  const params = new URL(request.url).searchParams;

  const attending = params.get('attending');
  const query = params.get('q')?.trim();

  const result = await listRsvps(
    {
      actor: session.actor,
      invitationId: id,
      ...(attending === null || attending === '' ? {} : { attending: attending === 'true' }),
      ...(query ? { query } : {}),
      limit: numberOr(params.get('limit'), 50),
      offset: numberOr(params.get('offset'), 0),
    },
    { invitations: container().invitations, rsvps: container().rsvps },
  );

  if (!result.ok) {
    return result.code === 'FORBIDDEN' ? forbidden('Not permitted') : notFound('Invitation');
  }

  return ok({
    // Mapped explicitly. The record type carries no credential, and writing
    // the fields out means a column added to the table cannot appear here by
    // accident.
    rsvps: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      attending: row.attending,
      partySize: row.partySize,
      phone: row.phone,
      note: row.note,
      source: row.source,
      submittedAt: row.submittedAt.toISOString(),
    })),
    total: result.total,
  });
}

function numberOr(raw: string | null, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
