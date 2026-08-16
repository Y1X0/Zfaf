import { Slug, isReservedSlug, normalizeSlug } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { requireActor } from '../../../../../server/request-context.js';
import { ok, rateLimited, unauthorized } from '../../../../../server/responses.js';

/**
 * `GET /api/v1/slugs/available?slug=…` — the publish dialog's live check (D6.1).
 *
 * **Advisory only.** It is never what makes publishing safe: between this
 * answer and the write, someone else can claim the name. Uniqueness is
 * enforced by the database index, and `publishInvitation` reports `SLUG_TAKEN`
 * when it loses that race. This exists so the owner learns about a collision
 * while typing rather than after pressing publish.
 *
 * Authentication is required and the endpoint is rate limited, because
 * otherwise it is a free oracle for enumerating which weddings exist on the
 * platform — the same reason the QR route is owner-scoped.
 */

export const runtime = 'nodejs';

const RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export async function GET(request: Request): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const deps = container();
  const verdict = await deps.rateLimiter.consume(
    `slug-check:${session.actor.kind === 'user' ? session.actor.userId : session.ipHash}`,
    RATE_LIMIT.limit,
    RATE_LIMIT.windowMs,
    deps.clock.now(),
  );
  if (!verdict.allowed) return rateLimited(verdict.retryAfterSeconds ?? 60);

  const requested = new URL(request.url).searchParams.get('slug') ?? '';

  // The suggestion is what the field would become if the owner accepted a
  // repair — shown alongside the error rather than silently substituted, so
  // nobody discovers after sending 250 links that we picked the address.
  const suggestion = normalizeSlug(requested).slice(0, 48).replace(/-+$/, '');
  const parsed = Slug.parse(requested);

  if (!parsed.ok) {
    return ok({
      slug: requested,
      available: false,
      issue: parsed.error,
      suggestion: suggestion === requested ? null : suggestion || null,
    });
  }

  // Checked before touching the database: a reserved word is refused whatever
  // the table says, and the list is the domain's, not a row somebody could add.
  if (isReservedSlug(parsed.value.value)) {
    return ok({ slug: parsed.value.value, available: false, issue: 'RESERVED', suggestion: null });
  }

  const available = await deps.invitations.isSlugAvailable(parsed.value.value);
  return ok({
    slug: parsed.value.value,
    available,
    issue: available ? null : 'TAKEN',
    suggestion: null,
  });
}
