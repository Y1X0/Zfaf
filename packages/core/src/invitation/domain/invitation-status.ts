import { type Result, err, ok } from '@zfaf/shared';

/**
 * Invitation lifecycle.
 *
 * Encoded as an explicit transition table rather than scattered `if` checks, so
 * that "can this invitation be deleted right now?" has exactly one answer and
 * every illegal transition is a test case rather than a bug report.
 */

export const INVITATION_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'PAUSED',
  'EXPIRED',
  'SUSPENDED',
  'DELETED',
] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const INVITATION_TRANSITIONS = [
  'publish',
  'unpublish',
  'republish',
  'expire',
  'suspend',
  'unsuspend',
  'delete',
  'restore',
] as const;

export type InvitationTransition = (typeof INVITATION_TRANSITIONS)[number];

export type TransitionIssue = 'ILLEGAL_TRANSITION' | 'SUSPENDED_REQUIRES_STAFF' | 'TERMINAL_STATE';

/**
 * Allowed transitions.
 *
 * Notable choices:
 * - `EXPIRED → publish` is allowed: an owner who moves the wedding date must be
 *   able to bring the invitation back without recreating it.
 * - `SUSPENDED` is only left through `unsuspend`, and only staff may perform it.
 *   An owner must not be able to lift a moderation action on themselves.
 * - `DELETED` is not terminal: soft-deleted invitations are restorable for 30
 *   days (docs/03-database-erd.md §7).
 */
const TRANSITIONS: Readonly<
  Record<InvitationStatus, Partial<Record<InvitationTransition, InvitationStatus>>>
> = {
  DRAFT: {
    publish: 'PUBLISHED',
    delete: 'DELETED',
    suspend: 'SUSPENDED',
  },
  PUBLISHED: {
    republish: 'PUBLISHED',
    unpublish: 'PAUSED',
    expire: 'EXPIRED',
    suspend: 'SUSPENDED',
    delete: 'DELETED',
  },
  PAUSED: {
    publish: 'PUBLISHED',
    expire: 'EXPIRED',
    suspend: 'SUSPENDED',
    delete: 'DELETED',
  },
  EXPIRED: {
    publish: 'PUBLISHED',
    suspend: 'SUSPENDED',
    delete: 'DELETED',
  },
  SUSPENDED: {
    unsuspend: 'PAUSED',
    delete: 'DELETED',
  },
  DELETED: {
    restore: 'DRAFT',
  },
};

/** Transitions only platform staff may perform. */
const STAFF_ONLY: ReadonlySet<InvitationTransition> = new Set(['suspend', 'unsuspend']);

export interface TransitionContext {
  /** Whether the actor is platform staff (support/admin/superadmin). */
  readonly isStaff: boolean;
}

export function canTransition(
  from: InvitationStatus,
  transition: InvitationTransition,
  context: TransitionContext,
): Result<InvitationStatus, TransitionIssue> {
  const next = TRANSITIONS[from][transition];
  if (!next) return err('ILLEGAL_TRANSITION');
  if (STAFF_ONLY.has(transition) && !context.isStaff) return err('SUSPENDED_REQUIRES_STAFF');
  return ok(next);
}

export function allowedTransitions(
  from: InvitationStatus,
  context: TransitionContext,
): readonly InvitationTransition[] {
  return (Object.keys(TRANSITIONS[from]) as InvitationTransition[]).filter(
    (transition) => !STAFF_ONLY.has(transition) || context.isStaff,
  );
}

/** Whether the public page should serve this invitation's content. */
export function isPubliclyVisible(status: InvitationStatus): boolean {
  return status === 'PUBLISHED';
}

/**
 * The HTTP-ish outcome the public route should produce.
 *
 * Kept in the domain (as a semantic name, not a status code) so that the
 * distinction between "gone", "blocked" and "never existed" is a domain
 * decision rather than a detail of one route handler.
 */
export type PublicVisibility = 'VISIBLE' | 'NOT_FOUND' | 'GONE' | 'BLOCKED';

export function publicVisibilityFor(status: InvitationStatus): PublicVisibility {
  switch (status) {
    case 'PUBLISHED':
      return 'VISIBLE';
    case 'EXPIRED':
      return 'GONE';
    case 'SUSPENDED':
      return 'BLOCKED';
    // A draft, a paused invitation and a deleted one are indistinguishable to
    // an outsider on purpose: revealing that a slug exists but is unpublished
    // leaks information about invitations that are none of their business.
    case 'DRAFT':
    case 'PAUSED':
    case 'DELETED':
      return 'NOT_FOUND';
  }
}
