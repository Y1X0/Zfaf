/**
 * Who is acting (docs/09-auth-and-rbac.md §1).
 *
 * Modelled as a discriminated union rather than `session | null` so that every
 * authorization decision is forced to handle the anonymous case explicitly.
 * "We forgot the logged-out branch" is one of the most common ways an
 * authorization check ends up wrong.
 */

export const USER_ROLES = ['customer', 'planner', 'support', 'admin', 'superadmin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended', 'pending_deletion'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const MEMBERSHIP_ROLES = ['owner', 'editor', 'viewer'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export interface Membership {
  readonly invitationId: string;
  readonly role: MembershipRole;
}

export type Actor =
  | { readonly kind: 'anonymous'; readonly ipHash: string }
  | { readonly kind: 'guest'; readonly invitationId: string; readonly guestId: string }
  | {
      readonly kind: 'user';
      readonly userId: string;
      readonly role: UserRole;
      readonly emailVerified: boolean;
      readonly status: UserStatus;
      readonly sessionId: string;
      readonly memberships: readonly Membership[];
    }
  | { readonly kind: 'system'; readonly jobName: string };

const STAFF_ROLES: ReadonlySet<UserRole> = new Set(['support', 'admin', 'superadmin']);

export function isStaff(actor: Actor): boolean {
  return actor.kind === 'user' && STAFF_ROLES.has(actor.role);
}

export function membershipRoleFor(actor: Actor, invitationId: string): MembershipRole | null {
  if (actor.kind !== 'user') return null;
  return actor.memberships.find((m) => m.invitationId === invitationId)?.role ?? null;
}

export function anonymous(ipHash: string): Actor {
  return { kind: 'anonymous', ipHash };
}

export function systemActor(jobName: string): Actor {
  return { kind: 'system', jobName };
}
