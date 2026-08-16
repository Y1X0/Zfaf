import type { UserStatus } from '../../authz/actor.js';

/**
 * Account lifecycle.
 *
 * Four states, and what each one may do. Written as a table so that "can a
 * suspended user still publish?" has one answer rather than being rediscovered
 * at each call site.
 *
 * ⚠️ **Open decision PD-02.** What happens to an owner's *already published*
 * invitations when their account is suspended is **not decided** in any ADR.
 * Nothing here changes invitation visibility, and no behaviour was invented —
 * see docs/19-decisions-pending-approval.md §6.
 */

export type AccountState = 'active' | 'unverified' | 'suspended' | 'pending_deletion';

export interface AccountCapabilities {
  /** May exchange credentials for a session. */
  readonly canAuthenticate: boolean;
  /** May hold a usable session at all. */
  readonly canHoldSession: boolean;
  /** May create and edit invitations. */
  readonly canEdit: boolean;
  /** May make an invitation publicly visible. */
  readonly canPublish: boolean;
  /** May recover the account by signing in. */
  readonly canRecoverBySigningIn: boolean;
}

const CAPABILITIES: Readonly<Record<AccountState, AccountCapabilities>> = {
  // Verified and in good standing.
  active: {
    canAuthenticate: true,
    canHoldSession: true,
    canEdit: true,
    canPublish: true,
    canRecoverBySigningIn: false,
  },

  // Signed up but has not confirmed the address. Deliberately permissive:
  // verification gates *publishing*, not the first run, so a new user reaches
  // a finished draft before being asked for anything (docs/00 §FR-A2).
  unverified: {
    canAuthenticate: true,
    canHoldSession: true,
    canEdit: true,
    canPublish: false,
    canRecoverBySigningIn: false,
  },

  // A moderation action. Everything stops immediately — this is the operational
  // requirement that justified database sessions over JWT (ADR-0006).
  suspended: {
    canAuthenticate: false,
    canHoldSession: false,
    canEdit: false,
    canPublish: false,
    canRecoverBySigningIn: false,
  },

  // Inside the 30-day recovery window (docs/09 §8). Signing in is the documented
  // way to cancel deletion, so authentication must still work.
  pending_deletion: {
    canAuthenticate: true,
    canHoldSession: true,
    canEdit: false,
    canPublish: false,
    canRecoverBySigningIn: true,
  },
};

export function capabilitiesFor(state: AccountState): AccountCapabilities {
  return CAPABILITIES[state];
}

/**
 * Derives the state from the stored row.
 *
 * Order matters: suspension outranks everything, and a pending deletion
 * outranks an unverified address.
 */
export function accountStateOf(user: {
  status: UserStatus;
  emailVerifiedAt: Date | null;
  deletionRequestedAt: Date | null;
}): AccountState {
  if (user.status === 'suspended') return 'suspended';
  if (user.status === 'pending_deletion' || user.deletionRequestedAt !== null) {
    return 'pending_deletion';
  }
  if (user.emailVerifiedAt === null) return 'unverified';
  return 'active';
}

export type AuthenticationRefusal = 'INVALID_CREDENTIALS' | 'ACCOUNT_SUSPENDED' | 'ACCOUNT_LOCKED';

/**
 * Whether this account may sign in at all.
 *
 * Returns `INVALID_CREDENTIALS` for a suspended account when
 * `revealSuspension` is false — the caller keeps the response uniform so the
 * login endpoint cannot be used to discover which accounts are suspended.
 */
export function canAuthenticate(
  state: AccountState,
  options: { lockedUntil?: Date | null; now: Date; revealSuspension?: boolean } = {
    now: new Date(0),
  },
): { allowed: true } | { allowed: false; reason: AuthenticationRefusal } {
  if (options.lockedUntil && options.lockedUntil.getTime() > options.now.getTime()) {
    return { allowed: false, reason: 'ACCOUNT_LOCKED' };
  }
  if (!capabilitiesFor(state).canAuthenticate) {
    return {
      allowed: false,
      reason: options.revealSuspension === true ? 'ACCOUNT_SUSPENDED' : 'INVALID_CREDENTIALS',
    };
  }
  return { allowed: true };
}

/**
 * The 30-day recovery window (docs/09 §8).
 *
 * Deletion is scheduled, not immediate, because an account deleted in anger two
 * days before a wedding takes the invitation down with it.
 */
export const DELETION_GRACE_DAYS = 30;

export function deletionDueAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

export function isDeletionDue(requestedAt: Date, now: Date): boolean {
  return now.getTime() >= deletionDueAt(requestedAt).getTime();
}
