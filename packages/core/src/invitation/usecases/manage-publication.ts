import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import { canTransition } from '../domain/invitation-status.js';
import type { InvitationRepository } from '../ports/invitation-repository.js';
import type { PublishAuditEntry, PublishDeps } from './publish-invitation.js';

/**
 * Taking an invitation back down, and putting an earlier version back up (D6.3).
 *
 * Both are the same idea from opposite ends: the published pointer is the only
 * mutable thing about publication, and every operation here moves it. No
 * snapshot is edited, none is deleted, and the version an owner rolls away from
 * is still there to roll back to. That is what makes offering the button
 * responsible rather than frightening.
 */

export interface UnpublishInput {
  readonly actor: Actor;
  readonly invitationId: string;
}

export type UnpublishResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION';
      readonly message: string;
    };

/**
 * Pauses a published invitation.
 *
 * The public page answers 404 afterwards, not 410: pausing is reversible and
 * the owner may well be mid-correction, so telling the world the invitation is
 * permanently gone would be a lie we would then have to take back.
 */
export async function unpublishInvitation(
  input: UnpublishInput,
  deps: PublishDeps,
): Promise<UnpublishResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN', message: 'Not permitted' };

  const invitation = await deps.repository.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  const allowed = can(input.actor, 'invitation:unpublish', {
    kind: 'invitation',
    id: invitation.id,
    ownerId: invitation.ownerId,
  });
  if (!allowed.allowed) return { ok: false, code: 'FORBIDDEN', message: 'Not permitted' };

  const transition = canTransition(invitation.status, 'unpublish', {
    isStaff: scope.isPlatformStaff,
  });
  if (!transition.ok) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `An invitation that is ${invitation.status.toLowerCase()} cannot be unpublished`,
    };
  }

  const now = deps.clock.now();
  const changed = await deps.repository.transitionStatus(
    invitation.id,
    scope,
    transition.value,
    now,
  );
  if (!changed) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  await deps.recordPublication({
    actorId: input.actor.kind === 'user' ? input.actor.userId : null,
    invitationId: invitation.id,
    action: 'unpublish',
    slug: invitation.slug,
    versionNumber: null,
    previousSlug: null,
    at: now,
  });

  return { ok: true };
}

// ── rollback ────────────────────────────────────────────────────────────────

export interface RollbackInput {
  readonly actor: Actor;
  readonly invitationId: string;
  readonly versionNumber: number;
}

export type RollbackResult =
  | { readonly ok: true; readonly versionNumber: number }
  | {
      readonly ok: false;
      readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'NO_SUCH_VERSION' | 'NOT_PUBLISHED';
      readonly message: string;
    };

/**
 * Puts an earlier published version back in front of guests.
 *
 * Authorised as `invitation:publish` rather than as its own action, and that is
 * the honest classification: rolling back changes what every guest sees, which
 * is exactly what publishing does. Giving it a weaker permission would let
 * someone who may not publish decide what is published.
 */
export async function rollbackInvitation(
  input: RollbackInput,
  deps: PublishDeps,
): Promise<RollbackResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN', message: 'Not permitted' };

  const invitation = await deps.repository.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  const allowed = can(input.actor, 'invitation:publish', {
    kind: 'invitation',
    id: invitation.id,
    ownerId: invitation.ownerId,
  });
  if (!allowed.allowed) return { ok: false, code: 'FORBIDDEN', message: 'Not permitted' };

  const now = deps.clock.now();
  const outcome = await deps.repository.rollbackToVersion(
    invitation.id,
    scope,
    input.versionNumber,
    now,
  );

  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.error,
      message:
        outcome.error === 'NO_SUCH_VERSION'
          ? 'That version does not exist'
          : outcome.error === 'NOT_PUBLISHED'
            ? 'Only a published invitation can be rolled back'
            : 'Invitation not found',
    };
  }

  await deps.recordPublication({
    actorId: input.actor.kind === 'user' ? input.actor.userId : null,
    invitationId: invitation.id,
    action: 'rollback',
    slug: invitation.slug,
    versionNumber: outcome.versionNumber,
    previousSlug: null,
    at: now,
  });

  return { ok: true, versionNumber: outcome.versionNumber };
}

// ── expiry ──────────────────────────────────────────────────────────────────

export interface ExpireDeps {
  readonly repository: InvitationRepository;
  readonly clock: Clock;
  readonly recordPublication: (entry: PublishAuditEntry) => Promise<void>;
}

/**
 * The scheduled expiry sweep (D6.3).
 *
 * The public route already refuses an invitation past its expiry date, so this
 * is not what makes expiry correct — it is what makes the *state* honest, so
 * that a dashboard, a list and an export all agree with what the public page
 * has been saying since midnight. Correctness at the edge, tidiness here; not
 * the other way round.
 *
 * Bounded per run so a backlog cannot turn into one enormous transaction.
 */
export async function expireDueInvitations(
  deps: ExpireDeps,
  limit = 500,
): Promise<{ readonly expired: number }> {
  const now = deps.clock.now();
  const ids = await deps.repository.expireDueInvitations(now, limit);

  for (const id of ids) {
    await deps.recordPublication({
      actorId: null,
      invitationId: id,
      action: 'unpublish',
      slug: null,
      versionNumber: null,
      previousSlug: null,
      at: now,
    });
  }

  return { expired: ids.length };
}

// ── visibility (D6.5, ADR-0017) ─────────────────────────────────────────────

export interface SetVisibilityInput {
  readonly actor: Actor;
  readonly invitationId: string;
  readonly visibility: 'UNLISTED' | 'INDEXED';
}

export type SetVisibilityResult =
  | { readonly ok: true; readonly visibility: 'UNLISTED' | 'INDEXED' }
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'NOT_FOUND'; readonly message: string };

/**
 * Chooses whether search engines may list the invitation.
 *
 * The two states are honest about what they are. `UNLISTED` is the default and
 * means exactly "not in search results" — it is **not** privacy, and the
 * interface is required to say so in three places (ADR-0017). `INDEXED` is an
 * explicit choice a couple makes.
 *
 * `PROTECTED` is deliberately not settable. It requires a credential the MVP
 * does not collect, and offering the state without the mechanism would give
 * someone the impression of protection they do not have — which is the exact
 * harm the ADR was written to prevent.
 *
 * Authorised as `invitation:update`, not `invitation:publish`: it changes how
 * an existing publication is served, not what is published.
 */
export async function setInvitationVisibility(
  input: SetVisibilityInput,
  deps: PublishDeps,
): Promise<SetVisibilityResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN', message: 'Not permitted' };

  const invitation = await deps.repository.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  const allowed = can(input.actor, 'invitation:update', {
    kind: 'invitation',
    id: invitation.id,
    ownerId: invitation.ownerId,
  });
  if (!allowed.allowed) return { ok: false, code: 'FORBIDDEN', message: 'Not permitted' };

  const changed = await deps.repository.setVisibility(
    invitation.id,
    scope,
    input.visibility,
    deps.clock.now(),
  );
  if (!changed) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  return { ok: true, visibility: input.visibility };
}
