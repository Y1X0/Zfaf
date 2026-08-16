import { describe, expect, it } from 'vitest';

import {
  INVITATION_STATUSES,
  type InvitationStatus,
  type InvitationTransition,
  allowedTransitions,
  canTransition,
  isPubliclyVisible,
  publicVisibilityFor,
} from './invitation-status.js';

const asOwner = { isStaff: false };
const asStaff = { isStaff: true };

describe('invitation lifecycle — allowed transitions', () => {
  it.each([
    ['DRAFT', 'publish', 'PUBLISHED'],
    ['DRAFT', 'delete', 'DELETED'],
    ['PUBLISHED', 'unpublish', 'PAUSED'],
    ['PUBLISHED', 'republish', 'PUBLISHED'],
    ['PUBLISHED', 'expire', 'EXPIRED'],
    ['PAUSED', 'publish', 'PUBLISHED'],
    // A postponed wedding must be revivable without recreating the invitation.
    ['EXPIRED', 'publish', 'PUBLISHED'],
    ['DELETED', 'restore', 'DRAFT'],
  ] as const)('%s --%s--> %s', (from, transition, expected) => {
    const result = canTransition(from, transition, asOwner);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  });
});

describe('invitation lifecycle — rejected transitions', () => {
  it.each([
    ['DRAFT', 'unpublish'],
    ['DRAFT', 'expire'],
    ['DRAFT', 'restore'],
    ['PUBLISHED', 'publish'],
    ['PAUSED', 'unpublish'],
    ['EXPIRED', 'expire'],
    ['DELETED', 'publish'],
    ['DELETED', 'delete'],
    ['SUSPENDED', 'publish'],
    ['SUSPENDED', 'republish'],
  ] as const)('%s --%s--> rejected', (from, transition) => {
    const result = canTransition(from, transition, asOwner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('ILLEGAL_TRANSITION');
  });
});

describe('moderation transitions are staff-only', () => {
  it('an owner cannot suspend', () => {
    const result = canTransition('PUBLISHED', 'suspend', asOwner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('SUSPENDED_REQUIRES_STAFF');
  });

  it('an owner cannot lift a suspension on themselves', () => {
    const result = canTransition('SUSPENDED', 'unsuspend', asOwner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('SUSPENDED_REQUIRES_STAFF');
  });

  it('staff can suspend and unsuspend', () => {
    expect(canTransition('PUBLISHED', 'suspend', asStaff).ok).toBe(true);
    expect(canTransition('SUSPENDED', 'unsuspend', asStaff).ok).toBe(true);
  });

  it('unsuspending returns to PAUSED, not straight back to PUBLISHED', () => {
    const result = canTransition('SUSPENDED', 'unsuspend', asStaff);
    expect(result.ok && result.value).toBe('PAUSED');
  });
});

describe('transition table completeness', () => {
  it('every status is reachable and every listed transition resolves', () => {
    for (const status of INVITATION_STATUSES) {
      for (const transition of allowedTransitions(status as InvitationStatus, asStaff)) {
        const result = canTransition(
          status as InvitationStatus,
          transition as InvitationTransition,
          asStaff,
        );
        expect(result.ok).toBe(true);
      }
    }
  });

  it('hides staff-only transitions from owners', () => {
    const ownerTransitions = allowedTransitions('PUBLISHED', asOwner);
    expect(ownerTransitions).not.toContain('suspend');
    expect(allowedTransitions('PUBLISHED', asStaff)).toContain('suspend');
  });
});

describe('public visibility', () => {
  it('serves content only when published', () => {
    expect(isPubliclyVisible('PUBLISHED')).toBe(true);
    for (const status of ['DRAFT', 'PAUSED', 'EXPIRED', 'SUSPENDED', 'DELETED'] as const) {
      expect(isPubliclyVisible(status)).toBe(false);
    }
  });

  it('distinguishes gone from blocked from never-existed', () => {
    expect(publicVisibilityFor('PUBLISHED')).toBe('VISIBLE');
    expect(publicVisibilityFor('EXPIRED')).toBe('GONE');
    expect(publicVisibilityFor('SUSPENDED')).toBe('BLOCKED');
  });

  it('does not reveal that an unpublished slug exists', () => {
    // A draft, a paused and a deleted invitation must be indistinguishable to
    // an outsider; anything else leaks the existence of private invitations.
    expect(publicVisibilityFor('DRAFT')).toBe('NOT_FOUND');
    expect(publicVisibilityFor('PAUSED')).toBe('NOT_FOUND');
    expect(publicVisibilityFor('DELETED')).toBe('NOT_FOUND');
  });
});
