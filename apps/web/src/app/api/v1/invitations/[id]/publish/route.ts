import { getEnv } from '@zfaf/config';
import {
  type PublishAuditEntry,
  publicInvitationUrl,
  publishInvitation,
  rollbackInvitation,
  setInvitationVisibility,
  unpublishInvitation,
} from '@zfaf/core';

import { container } from '../../../../../../server/container.js';
import { requireActor } from '../../../../../../server/request-context.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
  rateLimited,
  readJsonBody,
  unauthorized,
} from '../../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../../server/origin.js';

/**
 * Publication (D6.2, D6.3).
 *
 * `POST` publishes or republishes, `DELETE` takes the invitation back down.
 * Rolling back is a `POST` carrying a version number, because it is the same
 * decision as publishing — "this is what guests see now" — and giving it its
 * own weaker-sounding endpoint would invite giving it a weaker permission.
 *
 * As with autosave, the route is thin: every rule lives in the use case, and
 * this file owns only HTTP.
 */

/** Publishing is rare and expensive; a low ceiling costs an honest user nothing. */
const PUBLISH_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const { id } = await context.params;
  const deps = container();

  const verdict = await deps.rateLimiter.consume(
    `publish:${session.actor.kind === 'user' ? session.actor.userId : session.ipHash}`,
    PUBLISH_RATE_LIMIT.limit,
    PUBLISH_RATE_LIMIT.windowMs,
    deps.clock.now(),
  );
  if (!verdict.allowed) return rateLimited(verdict.retryAfterSeconds ?? 60);

  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return body.response;

  const payload =
    body.body !== null && typeof body.body === 'object' && !Array.isArray(body.body)
      ? (body.body as Record<string, unknown>)
      : {};

  const useCaseDeps = {
    repository: deps.invitations,
    clock: deps.clock,
    recordPublication: (entry: PublishAuditEntry) => recordPublication(entry, session.ipHash),
  };

  // ── rollback ──────────────────────────────────────────────────────────────

  const rollbackTo = payload['rollbackToVersion'];
  if (rollbackTo !== undefined) {
    if (typeof rollbackTo !== 'number' || !Number.isInteger(rollbackTo) || rollbackTo < 1) {
      return badRequest('INVALID_VERSION', 'rollbackToVersion must be a positive integer');
    }

    const result = await rollbackInvitation(
      { actor: session.actor, invitationId: id, versionNumber: rollbackTo },
      useCaseDeps,
    );
    if (result.ok) return ok({ versionNumber: result.versionNumber, rolledBack: true });

    switch (result.code) {
      case 'NOT_FOUND':
      case 'NO_SUCH_VERSION':
        return notFound('Version');
      case 'NOT_PUBLISHED':
        return conflict('NOT_PUBLISHED', result.message);
      case 'FORBIDDEN':
        return forbidden(result.message);
    }
  }

  // ── publish ───────────────────────────────────────────────────────────────

  const slug = payload['slug'];
  if (slug !== undefined && typeof slug !== 'string') {
    return badRequest('INVALID_SLUG', 'slug must be a string');
  }

  const expires = payload['expiresAt'];
  if (expires !== undefined && expires !== null && typeof expires !== 'string') {
    return badRequest('INVALID_EXPIRY', 'expiresAt must be an ISO date string or null');
  }
  const expiresAt = typeof expires === 'string' ? new Date(expires) : (expires as null | undefined);
  if (expiresAt instanceof Date && Number.isNaN(expiresAt.getTime())) {
    return badRequest('INVALID_EXPIRY', 'expiresAt is not a valid date');
  }

  const result = await publishInvitation(
    {
      actor: session.actor,
      invitationId: id,
      ...(slug === undefined ? {} : { slug }),
      ...(expires === undefined ? {} : { expiresAt: expiresAt ?? null }),
    },
    useCaseDeps,
  );

  if (result.ok) {
    return ok({
      slug: result.slug,
      url: publicInvitationUrl(getEnv().PUBLIC_BASE_URL, result.slug),
      versionNumber: result.versionNumber,
      publishedAt: result.publishedAt.toISOString(),
      firstPublication: result.firstPublication,
    });
  }

  switch (result.code) {
    case 'NOT_FOUND':
      return notFound('Invitation');
    case 'FORBIDDEN':
      return forbidden(result.message);
    case 'ILLEGAL_TRANSITION':
      return conflict('ILLEGAL_TRANSITION', result.message);
    case 'SLUG_TAKEN':
      return conflict('SLUG_TAKEN', result.message);
    case 'INVALID_SLUG':
      return badRequest('INVALID_SLUG', result.message, { issue: result.issue });
    case 'NOT_READY':
      // The issues are what the publish dialog lists. They name our own
      // required fields, not another tenant's data.
      return badRequest('NOT_READY', result.message, { issues: result.issues });
  }
}

/**
 * `PATCH` changes visibility without republishing (D6.5, ADR-0017).
 *
 * Separate from `POST` because it is a different decision: publishing chooses
 * *what* guests see, this chooses whether a search engine may list it. An
 * owner must be able to change their mind about indexing without pushing a new
 * version in front of everyone who already has the link.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const body = await readJsonBody(request, 1024);
  if (!body.ok) return body.response;

  const payload =
    body.body !== null && typeof body.body === 'object' && !Array.isArray(body.body)
      ? (body.body as Record<string, unknown>)
      : {};

  const visibility = payload['visibility'];
  // `PROTECTED` is refused here rather than silently ignored: it needs a
  // credential the MVP does not collect, and accepting the word would give an
  // owner the impression of protection they do not have.
  if (visibility !== 'UNLISTED' && visibility !== 'INDEXED') {
    return badRequest('INVALID_VISIBILITY', 'visibility must be UNLISTED or INDEXED');
  }

  const { id } = await context.params;
  const deps = container();
  const result = await setInvitationVisibility(
    { actor: session.actor, invitationId: id, visibility },
    {
      repository: deps.invitations,
      clock: deps.clock,
      recordPublication: (entry) => recordPublication(entry, session.ipHash),
    },
  );

  if (result.ok) return ok({ visibility: result.visibility });
  return result.code === 'FORBIDDEN' ? forbidden(result.message) : notFound('Invitation');
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const { id } = await context.params;
  const deps = container();

  const result = await unpublishInvitation(
    { actor: session.actor, invitationId: id },
    {
      repository: deps.invitations,
      clock: deps.clock,
      recordPublication: (entry) => recordPublication(entry, session.ipHash),
    },
  );

  if (result.ok) return ok({ unpublished: true });

  switch (result.code) {
    case 'NOT_FOUND':
      return notFound('Invitation');
    case 'FORBIDDEN':
      return forbidden(result.message);
    case 'ILLEGAL_TRANSITION':
      return conflict('ILLEGAL_TRANSITION', result.message);
  }
}

/**
 * Records the publication in the audit log.
 *
 * Publishing is the moment an invitation becomes visible to the world, and
 * unpublishing the moment it stops. Both are exactly the events someone will
 * want reconstructed later — "when did this go live", "who took it down",
 * "which version were guests seeing on the night".
 */
async function recordPublication(entry: PublishAuditEntry, ipHash: string): Promise<void> {
  await container().audit.record(
    {
      actorId: entry.actorId,
      actorType: entry.actorId === null ? 'system' : 'user',
      action: `invitation.${entry.action}`,
      resourceType: 'invitation',
      resourceId: entry.invitationId,
      metadata: {
        slug: entry.slug ?? '',
        versionNumber: entry.versionNumber ?? 0,
        previousSlug: entry.previousSlug ?? '',
      },
      ipHash: new TextEncoder().encode(ipHash),
    },
    entry.at,
  );
}
