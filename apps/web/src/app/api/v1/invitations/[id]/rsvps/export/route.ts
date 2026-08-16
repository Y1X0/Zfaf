import { exportRsvps, rsvpCsv } from '@zfaf/core';

import { container } from '../../../../../../../server/container.js';
import { requireActor } from '../../../../../../../server/request-context.js';
import { forbidden, notFound, unauthorized } from '../../../../../../../server/responses.js';

/**
 * `GET /api/v1/invitations/{id}/rsvps/export` — the guest list as CSV (D7.6).
 *
 * Two hazards live in this one response, and both are handled in
 * `@zfaf/core`'s `rsvpCsv` rather than here, so they hold for any future
 * caller:
 *
 *   • **Formula injection.** A guest chooses their own name, and Excel runs a
 *     cell beginning `=` as code on the couple's laptop. Cells are defused at
 *     export, not at input — the guest's real name belongs in the database.
 *   • **Arabic in Excel.** Without a UTF-8 byte-order mark, Excel on Windows
 *     reads the file in the system code page and an Arabic guest list opens as
 *     mojibake, which for this product means the file is useless.
 *
 * Authorised as `rsvp:export`, separately from `rsvp:read`: seeing a list on a
 * screen and carrying it away as a file are different acts.
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
  const result = await exportRsvps(
    { actor: session.actor, invitationId: id },
    { invitations: container().invitations, rsvps: container().rsvps },
  );

  if (!result.ok) {
    return result.code === 'FORBIDDEN' ? forbidden('Not permitted') : notFound('Invitation');
  }

  const csv = rsvpCsv(
    result.rows.map((row) => ({
      name: row.name,
      attending: row.attending,
      partySize: row.partySize,
      phone: row.phone,
      note: row.note,
      submittedAt: row.submittedAt,
      source: row.source,
    })),
    result.locale,
  );

  const filename = `${result.slug ?? 'invitation'}-rsvps.csv`;

  return new Response(csv, {
    headers: {
      // `charset=utf-8` as well as the BOM: the header is what a browser and a
      // decent spreadsheet read, the BOM is what Excel on Windows reads.
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // Guest data must never sit in a shared cache.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
