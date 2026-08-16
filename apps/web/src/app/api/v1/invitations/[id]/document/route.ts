import { type PatchAuditEntry, updateDraftDocument } from '@zfaf/core';

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

/**
 * `PATCH /api/v1/invitations/{id}/document` — autosave (D5.5, D5.7).
 *
 * The route is deliberately thin. Authorisation, the patch allowlist, conflict
 * detection and the audit record all live in
 * `packages/core/src/invitation/usecases/update-draft.ts`, so the rules hold
 * identically whether they are reached from here, from a future mobile client,
 * or from a background job. A route that re-implemented any of them would be a
 * second place for them to drift.
 *
 * What this file owns is HTTP: reading a bounded body, mapping outcomes onto
 * status codes, and rate limiting.
 */

/** 120 saves a minute, per docs/04 §11. Generous for typing, useless for a loop. */
const AUTOSAVE_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const { id } = await context.params;
  const deps = container();

  const verdict = await deps.rateLimiter.consume(
    // Keyed by user rather than by IP: several people behind one office NAT
    // must not throttle each other, and a signed-in user is the unit we can
    // actually hold accountable.
    `autosave:${session.actor.kind === 'user' ? session.actor.userId : session.ipHash}`,
    AUTOSAVE_RATE_LIMIT.limit,
    AUTOSAVE_RATE_LIMIT.windowMs,
    deps.clock.now(),
  );
  if (!verdict.allowed) return rateLimited(verdict.retryAfterSeconds ?? 60);

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const payload = body.body;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return badRequest('MALFORMED_BODY', 'Body must be an object');
  }

  const record = payload as Record<string, unknown>;
  const baseVersion = record['baseVersion'];
  if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return badRequest('MISSING_BASE_VERSION', 'baseVersion must be a non-negative integer');
  }

  const result = await updateDraftDocument(
    {
      actor: session.actor,
      invitationId: id,
      baseVersion,
      // Passed through untouched. Validation belongs to the domain, and doing
      // any of it here would mean doing it twice.
      patch: record['patch'],
    },
    {
      repository: deps.invitations,
      clock: deps.clock,
      recordRejection: (entry) => recordRejection(entry, session.ipHash),
    },
  );

  if (result.ok) {
    return ok({ version: result.version, savedAt: result.savedAt.toISOString() });
  }

  switch (result.code) {
    case 'NOT_FOUND':
      return notFound('Invitation');
    case 'FORBIDDEN':
      return forbidden('Not permitted to edit this invitation');
    case 'INVALID_PATCH':
      // The violations are returned so a legitimate but buggy client can be
      // fixed. They describe our rules, not another tenant's data.
      return badRequest('PATCH_REJECTED', result.message, result.violations);
    case 'PATCH_FAILED':
      return badRequest('PATCH_NOT_APPLICABLE', result.message);
    case 'VERSION_CONFLICT':
      // Everything the client needs to merge without another round trip:
      // an empty `conflictingPaths` means the two edits are disjoint and it
      // may rebase silently (docs/06 §4.3).
      return conflict('VERSION_CONFLICT', result.message, {
        currentVersion: result.currentVersion,
        currentDocument: result.currentDocument,
        conflictingPaths: result.conflictingPaths,
      });
  }
}

/**
 * Writes a refused patch to the audit log.
 *
 * The builder never produces a forbidden path, so one arriving means a broken
 * client or someone probing the endpoint. Recorded with the paths but
 * deliberately **without the values** — a rejected patch's payload is
 * attacker-controlled and there is no reason to store it.
 */
async function recordRejection(entry: PatchAuditEntry, ipHash: string): Promise<void> {
  const deps = container();
  await deps.audit.record(
    {
      actorId: entry.actorId,
      actorType: 'user',
      action: 'invitation.patch_rejected',
      resourceType: 'invitation',
      resourceId: entry.invitationId,
      // Flat scalars, because that is what the audit metadata contract
      // accepts — and a flat shape is what makes these rows searchable when
      // somebody asks "who has been probing this endpoint".
      metadata: {
        violationCount: entry.violations.length,
        paths: entry.violations.map((violation) => violation.path).join(' '),
        reasons: [...new Set(entry.violations.map((violation) => violation.reason))].join(' '),
        actor: entry.actorDescription,
      },
      ipHash: new TextEncoder().encode(ipHash),
    },
    entry.at,
  );
}
