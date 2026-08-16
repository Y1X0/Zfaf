import { adminListInvitations } from '@zfaf/core';

import {
  adminAuditor,
  adminNotFound,
  adminSession,
  withAdminHeaders,
} from '../../../../server/admin.js';
import { container } from '../../../../server/container.js';
import { ok } from '../../../../server/responses.js';

/**
 * `GET /api/admin/invitations` — read-only invitation browse and search (D8.6).
 *
 * Returns statuses, slugs, owners and a reply **count**. Never a reply. The
 * repository behind this has no code path that could produce a guest's name,
 * which is what makes "staff cannot read guest data" a property of the system
 * rather than a rule people follow (docs/09 §3.4).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const gate = await adminSession();
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const result = await adminListInvitations(
    {
      actor: gate.session.actor,
      query: url.searchParams.get('q') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
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
