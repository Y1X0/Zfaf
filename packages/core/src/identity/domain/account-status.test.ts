import { describe, expect, it } from 'vitest';

import {
  DELETION_GRACE_DAYS,
  accountStateOf,
  canAuthenticate,
  capabilitiesFor,
  deletionDueAt,
  isDeletionDue,
} from './account-status.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');

describe('deriving account state', () => {
  it('is active when verified and in good standing', () => {
    expect(
      accountStateOf({ status: 'active', emailVerifiedAt: NOW, deletionRequestedAt: null }),
    ).toBe('active');
  });

  it('is unverified when the address has not been confirmed', () => {
    expect(
      accountStateOf({ status: 'active', emailVerifiedAt: null, deletionRequestedAt: null }),
    ).toBe('unverified');
  });

  it('suspension outranks every other signal', () => {
    expect(
      accountStateOf({ status: 'suspended', emailVerifiedAt: null, deletionRequestedAt: NOW }),
    ).toBe('suspended');
  });

  it('a pending deletion outranks an unverified address', () => {
    expect(
      accountStateOf({ status: 'active', emailVerifiedAt: null, deletionRequestedAt: NOW }),
    ).toBe('pending_deletion');
  });
});

describe('what each state may do', () => {
  it('active accounts may do everything', () => {
    const caps = capabilitiesFor('active');
    expect(caps).toMatchObject({ canAuthenticate: true, canEdit: true, canPublish: true });
  });

  it('unverified accounts may edit but not publish', () => {
    // Verification gates publishing, not the first run: a new user should reach
    // a finished draft before being asked for anything (docs/00 §FR-A2).
    const caps = capabilitiesFor('unverified');
    expect(caps.canAuthenticate).toBe(true);
    expect(caps.canEdit).toBe(true);
    expect(caps.canPublish).toBe(false);
  });

  it('suspended accounts may do nothing at all', () => {
    const caps = capabilitiesFor('suspended');
    expect(caps.canAuthenticate).toBe(false);
    expect(caps.canHoldSession).toBe(false);
    expect(caps.canEdit).toBe(false);
    expect(caps.canPublish).toBe(false);
  });

  it('a pending deletion can still sign in, which is how it is cancelled', () => {
    const caps = capabilitiesFor('pending_deletion');
    expect(caps.canAuthenticate).toBe(true);
    expect(caps.canRecoverBySigningIn).toBe(true);
    expect(caps.canEdit).toBe(false);
  });
});

describe('authentication gate', () => {
  it('lets an active account through', () => {
    expect(canAuthenticate('active', { now: NOW }).allowed).toBe(true);
  });

  it('does not reveal suspension by default', () => {
    // Otherwise the login endpoint tells an attacker which accounts are
    // suspended, which is information about other people's accounts.
    const verdict = canAuthenticate('suspended', { now: NOW });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('INVALID_CREDENTIALS');
  });

  it('reveals suspension only when explicitly asked to', () => {
    const verdict = canAuthenticate('suspended', { now: NOW, revealSuspension: true });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('ACCOUNT_SUSPENDED');
  });

  it('refuses while a lockout is in force and allows once it lapses', () => {
    const locked = canAuthenticate('active', {
      lockedUntil: new Date(NOW.getTime() + 60_000),
      now: NOW,
    });
    expect(locked.allowed).toBe(false);
    if (!locked.allowed) expect(locked.reason).toBe('ACCOUNT_LOCKED');

    const lapsed = canAuthenticate('active', {
      lockedUntil: new Date(NOW.getTime() - 1),
      now: NOW,
    });
    expect(lapsed.allowed).toBe(true);
  });
});

describe('deletion grace window', () => {
  it('schedules deletion 30 days out rather than acting immediately', () => {
    // An account deleted in anger two days before a wedding would take the
    // invitation down with it.
    expect(DELETION_GRACE_DAYS).toBe(30);
    const due = deletionDueAt(NOW);
    expect(due.getTime() - NOW.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('is not due before the window closes, and is due after', () => {
    expect(isDeletionDue(NOW, new Date(NOW.getTime() + 29 * 86_400_000))).toBe(false);
    expect(isDeletionDue(NOW, new Date(NOW.getTime() + 30 * 86_400_000))).toBe(true);
  });
});

describe('PD-02 — suspension does not touch published invitations', () => {
  it('defines nothing about invitation visibility', () => {
    // No ADR decides what happens to an owner's already published invitations
    // when their account is suspended, so no behaviour was invented. The
    // capability table is about the *account*, not about published content.
    // See docs/19-decisions-pending-approval.md §6 (PD-02).
    const caps = capabilitiesFor('suspended');
    expect(Object.keys(caps).sort()).toEqual(
      [
        'canAuthenticate',
        'canEdit',
        'canHoldSession',
        'canPublish',
        'canRecoverBySigningIn',
      ].sort(),
    );
  });
});
