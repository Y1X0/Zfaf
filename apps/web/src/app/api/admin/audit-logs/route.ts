import { adminListAuditLog } from '@zfaf/core';

import {
  adminAuditor,
  adminNotFound,
  adminSession,
  withAdminHeaders,
} from '../../../../server/admin.js';
import { container } from '../../../../server/container.js';
import { ok } from '../../../../server/responses.js';

/**
 * `GET /api/admin/audit-logs` — the audit viewer (D8.7).
 *
 * The table is append-only and a trigger enforces it (M1): no route here, and
 * no route anywhere, can update or delete a row. An audit log an operator can
 * edit is not an audit log, and the guarantee is worth more in the database
 * than in a code review.
 *
 * A stricter role than the other two admin reads — `admin:read_audit_log`
 * excludes `support`. This is where an operator's own actions are recorded,
 * so who may read it is a different question from who may do support work.
 * Reading it is itself recorded, which does mean the next read shows the
 * previous one; that is intended.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const gate = await adminSession();
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const result = await adminListAuditLog(
    {
      actor: gate.session.actor,
      action: url.searchParams.get('action') ?? undefined,
      actorId: url.searchParams.get('actor') ?? undefined,
      resourceId: url.searchParams.get('resource') ?? undefined,
      limit: numeric(url.searchParams.get('limit')),
      offset: numeric(url.searchParams.get('offset')),
    },
    {
      admin: container().admin,
      clock: container().clock,
      recordAdminAccess: adminAuditor(gate.session.ipHash),
    },
  );

  if (!result.ok) return withAdminHeaders(adminNotFound());
  return withAdminHeaders(ok(result.page));
}

function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
