import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { systemScope } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import { canTransition } from '../../invitation/domain/invitation-status.js';
import type { InvitationRepository } from '../../invitation/ports/invitation-repository.js';

import type { AdminRepository } from '../ports/admin-repository.js';
import { type CdnPurger, invitationCachePaths } from '../ports/cdn-purger.js';

/**
 * The kill switch (D8.5).
 *
 * The operation the platform has when an invitation must stop being served
 * *now* — impersonation, a stolen photograph, content that should never have
 * been published. Four things happen, in this order, and the order is the
 * design:
 *
 *   1. **Authorise.** `admin:suspend_invitation`, which is a platform role and
 *      not a membership one. An owner cannot suspend their own invitation and,
 *      more importantly, cannot *un*suspend it — lifting a moderation action on
 *      yourself is not a thing this system permits (`invitation-status.ts`).
 *   2. **Write the row.** This is what protects every visitor who has not
 *      already been served a cached copy, and it is the step that must not be
 *      undone by a later failure.
 *   3. **Purge the edge.** Without it the CDN keeps handing out the page for
 *      up to five minutes. A failed purge is reported, never silent, and never
 *      rolls back step 2.
 *   4. **Audit.** Including whether the purge worked, because "we suspended it
 *      at 14:02 but the edge kept serving it" is exactly the fact an incident
 *      review needs and exactly the fact that gets lost otherwise.
 *
 * Unsuspending returns the invitation to `PAUSED`, never straight to
 * `PUBLISHED`. Moderation clearing a block does not decide that something
 * should be live again; the owner does, by publishing.
 */

export type ModerationAction = 'suspend' | 'unsuspend';

export interface ModerateInvitationInput {
  readonly actor: Actor;
  readonly invitationId: string;
  readonly action: ModerationAction;
  /** Free text from an operator. Recorded in the audit entry, bounded. */
  readonly reason: string;
}

export const MODERATION_REASON_MAX = 500;

export interface ModerationAuditEntry {
  readonly actorId: string | null;
  readonly invitationId: string;
  readonly action: ModerationAction;
  readonly reason: string;
  readonly previousStatus: string;
  readonly nextStatus: string;
  readonly cdn: string;
  readonly purged: boolean;
  readonly purgeError: string | null;
  readonly at: Date;
}

export type ModerateInvitationResult =
  | {
      readonly ok: true;
      readonly status: string;
      /** False when no CDN is configured or the purge failed. Reported, not hidden. */
      readonly purged: boolean;
      readonly purgeError: string | null;
    }
  | {
      readonly ok: false;
      readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'INVALID';
      readonly message: string;
    };

export interface ModerateInvitationDeps {
  readonly admin: AdminRepository;
  readonly invitations: InvitationRepository;
  readonly cdn: CdnPurger;
  readonly clock: Clock;
  readonly recordModeration: (entry: ModerationAuditEntry) => Promise<void>;
}

export async function moderateInvitation(
  input: ModerateInvitationInput,
  deps: ModerateInvitationDeps,
): Promise<ModerateInvitationResult> {
  const permission =
    input.action === 'suspend' ? 'admin:suspend_invitation' : 'admin:unsuspend_invitation';
  if (!can(input.actor, permission).allowed) {
    // 403 rather than 404 here, unlike the tenant routes: the caller is a
    // signed-in operator being told they lack a role, not a stranger probing
    // for which ids exist.
    return { ok: false, code: 'FORBIDDEN', message: 'Not permitted' };
  }

  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > MODERATION_REASON_MAX) {
    // A moderation action with no stated reason is unreviewable later, which
    // defeats the point of recording it at all.
    return { ok: false, code: 'INVALID', message: 'A reason is required' };
  }

  const invitation = await deps.admin.findInvitationForModeration(input.invitationId);
  if (!invitation) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  const transition = canTransition(invitation.status, input.action, { isStaff: true });
  if (!transition.ok) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `An invitation that is ${invitation.status.toLowerCase()} cannot be ${input.action}ed`,
    };
  }

  const now = deps.clock.now();

  /**
   * A named system scope, not the operator's own.
   *
   * `tenantScopeFor` on a staff actor would also reach this row, but it would
   * reach it as "a user who happens to be staff". Naming the job makes the
   * cross-tenant write deliberate and legible in review — which is the whole
   * reason `systemScope` exists.
   */
  const changed = await deps.invitations.transitionStatus(
    invitation.id,
    systemScope('moderation'),
    transition.value,
    now,
  );
  if (!changed) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  /**
   * Every address this invitation occupies, including the ones it used to.
   *
   * A rename leaves the old address answering 301 (ADR-0013), and a printed QR
   * code carries it forever — so clearing only the current one would leave the
   * most durable route to a suspended page working.
   */
  const purge = await deps.cdn.purgePaths(
    invitationCachePaths(invitation.slug, invitation.previousSlugs),
  );

  await deps.recordModeration({
    actorId: input.actor.kind === 'user' ? input.actor.userId : null,
    invitationId: invitation.id,
    action: input.action,
    reason,
    previousStatus: invitation.status,
    nextStatus: transition.value,
    cdn: deps.cdn.key,
    purged: purge.purged,
    purgeError: purge.purged ? null : purge.reason,
    at: now,
  });

  return {
    ok: true,
    status: transition.value,
    purged: purge.purged,
    purgeError: purge.purged ? null : purge.reason,
  };
}
