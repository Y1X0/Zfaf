import { type Actor, type MembershipRole, isStaff } from './actor.js';
import { effectiveRole } from './tenant-scope.js';

/**
 * The single authorization decision point (docs/09-auth-and-rbac.md §3.4).
 *
 * Every permission question in the system resolves here. Scattered checks are
 * the primary source of IDOR bugs, and a single table can be reviewed and
 * tested exhaustively — which the matrix test does.
 */

export const ACTIONS = [
  'invitation:read',
  'invitation:update',
  'invitation:publish',
  'invitation:unpublish',
  'invitation:change_slug',
  'invitation:delete',
  'invitation:restore',
  'invitation:invite_member',
  'rsvp:read',
  'rsvp:export',
  'rsvp:delete',
  'analytics:read',
  'media:upload',
  'media:delete',
  'admin:suspend_invitation',
  'admin:unsuspend_invitation',
  'admin:suspend_user',
  'admin:read_users',
  'admin:read_audit_log',
  'admin:publish_template',
  'admin:update_plan',
  'admin:change_user_role',
] as const;

export type Action = (typeof ACTIONS)[number];

export interface InvitationResource {
  readonly kind: 'invitation';
  readonly id: string;
  readonly ownerId: string;
}

export type Resource = InvitationResource;

export type DenialReason =
  | 'ANONYMOUS'
  | 'ACCOUNT_SUSPENDED'
  | 'EMAIL_NOT_VERIFIED'
  | 'NOT_A_MEMBER'
  | 'INSUFFICIENT_MEMBERSHIP_ROLE'
  | 'INSUFFICIENT_PLATFORM_ROLE'
  | 'RESOURCE_REQUIRED'
  | 'GUEST_DATA_IS_NOT_STAFF_READABLE';

export type Decision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenialReason };

const allow = (): Decision => ({ allowed: true });
const deny = (reason: DenialReason): Decision => ({ allowed: false, reason });

const ROLE_RANK: Readonly<Record<MembershipRole, number>> = { viewer: 1, editor: 2, owner: 3 };

function hasAtLeast(actual: MembershipRole | null, required: MembershipRole): boolean {
  return actual !== null && ROLE_RANK[actual] >= ROLE_RANK[required];
}

/**
 * Actions where guest personal data would be exposed.
 *
 * Deliberately denied even to superadmins (docs/09-auth-and-rbac.md §3.3):
 * guests are third parties who never agreed to anything with us, there is no
 * legitimate operational reason to browse their names and phone numbers, and
 * excluding staff shrinks the blast radius of a compromised staff account.
 */
const GUEST_DATA_ACTIONS: ReadonlySet<Action> = new Set([
  'rsvp:read',
  'rsvp:export',
  'rsvp:delete',
]);

const PLATFORM_ROLE_REQUIREMENTS: Partial<Record<Action, readonly string[]>> = {
  'admin:suspend_invitation': ['support', 'admin', 'superadmin'],
  'admin:unsuspend_invitation': ['support', 'admin', 'superadmin'],
  'admin:read_users': ['support', 'admin', 'superadmin'],
  'admin:suspend_user': ['admin', 'superadmin'],
  'admin:read_audit_log': ['admin', 'superadmin'],
  'admin:publish_template': ['admin', 'superadmin'],
  'admin:update_plan': ['superadmin'],
  'admin:change_user_role': ['superadmin'],
};

export function can(actor: Actor, action: Action, resource?: Resource): Decision {
  // Administrative actions depend only on the platform role.
  const requiredPlatformRoles = PLATFORM_ROLE_REQUIREMENTS[action];
  if (requiredPlatformRoles) {
    if (actor.kind !== 'user') return deny('ANONYMOUS');
    if (actor.status === 'suspended') return deny('ACCOUNT_SUSPENDED');
    return requiredPlatformRoles.includes(actor.role)
      ? allow()
      : deny('INSUFFICIENT_PLATFORM_ROLE');
  }

  if (actor.kind !== 'user') return deny('ANONYMOUS');
  if (actor.status === 'suspended') return deny('ACCOUNT_SUSPENDED');

  if (!resource) return deny('RESOURCE_REQUIRED');

  // Staff may see and moderate invitations, but never guest personal data.
  if (GUEST_DATA_ACTIONS.has(action) && isStaff(actor) && actor.userId !== resource.ownerId) {
    const role = effectiveRole(actor, resource);
    if (role === null) return deny('GUEST_DATA_IS_NOT_STAFF_READABLE');
  }

  const role = effectiveRole(actor, resource);
  const staffMayRead = isStaff(actor) && !GUEST_DATA_ACTIONS.has(action);

  switch (action) {
    case 'invitation:read':
    case 'analytics:read':
      if (staffMayRead) return allow();
      return hasAtLeast(role, 'viewer')
        ? allow()
        : deny(role === null ? 'NOT_A_MEMBER' : 'INSUFFICIENT_MEMBERSHIP_ROLE');

    case 'invitation:update':
    case 'media:upload':
    case 'media:delete':
      return hasAtLeast(role, 'editor')
        ? allow()
        : deny(role === null ? 'NOT_A_MEMBER' : 'INSUFFICIENT_MEMBERSHIP_ROLE');

    case 'invitation:publish':
    case 'invitation:unpublish':
      if (!hasAtLeast(role, 'editor')) {
        return deny(role === null ? 'NOT_A_MEMBER' : 'INSUFFICIENT_MEMBERSHIP_ROLE');
      }
      // Verification gates publishing rather than sign-up: it keeps the first
      // run frictionless while still blocking bulk abuse (docs/00 §FR-A2).
      return actor.emailVerified ? allow() : deny('EMAIL_NOT_VERIFIED');

    case 'rsvp:read':
      return hasAtLeast(role, 'viewer')
        ? allow()
        : deny(role === null ? 'NOT_A_MEMBER' : 'INSUFFICIENT_MEMBERSHIP_ROLE');

    case 'rsvp:export':
    case 'rsvp:delete':
      return hasAtLeast(role, 'editor')
        ? allow()
        : deny(role === null ? 'NOT_A_MEMBER' : 'INSUFFICIENT_MEMBERSHIP_ROLE');

    // Owner-only: these change the link guests already hold, or destroy data.
    case 'invitation:change_slug':
    case 'invitation:delete':
    case 'invitation:restore':
    case 'invitation:invite_member':
      return hasAtLeast(role, 'owner')
        ? allow()
        : deny(role === null ? 'NOT_A_MEMBER' : 'INSUFFICIENT_MEMBERSHIP_ROLE');

    default:
      return deny('INSUFFICIENT_PLATFORM_ROLE');
  }
}

/** Throws-free helper for call sites that only need a boolean. */
export function isAllowed(actor: Actor, action: Action, resource?: Resource): boolean {
  return can(actor, action, resource).allowed;
}
