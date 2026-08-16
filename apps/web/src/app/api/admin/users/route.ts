import { adminListUsers } from '@zfaf/core';

import {
  adminAuditor,
  adminNotFound,
  adminSession,
  withAdminHeaders,
} from '../../../../server/admin.js';
import { container } from '../../../../server/container.js';
import { ok } from '../../../../server/responses.js';

/**
 * `GET /api/admin/users` — read-only account browse and search (D8.6).
 *
 * Everything an operator can do here is look. There is no suspend, no edit and
 * no delete: `admin:suspend_user` exists in the permission table but building
 * the endpoint is not in M8's scope, and a half-built moderation surface is
 * worse than none.
 *
 * The read itself is audited, including the search term. "Who looked up this
 * customer's account, and when" is the question a privacy complaint turns on,
 * and it cannot be answered after the fact if nobody wrote it down.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const gate = await adminSession();
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const result = await adminListUsers(
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

  // A support role that reached the gate but lacks the permission still gets
  // the same 404 as a stranger — the console does not enumerate its own
  // endpoints for people who cannot use them.
  if (!result.ok) return withAdminHeaders(adminNotFound());

  return withAdminHeaders(ok(result.page));
}

function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
