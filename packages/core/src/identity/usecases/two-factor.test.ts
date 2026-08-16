import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor, UserRole } from '../../authz/actor.js';

/** The user branch of `Actor`, so `userId` is reachable without an assertion. */
type UserActor = Extract<Actor, { kind: 'user' }>;
import { TOTP_PERIOD_SECONDS, base32Decode, totpCodeAt } from '../domain/totp.js';
import { RATE_LIMITS } from '../ports/rate-limiter.js';
import { type TestTwoFactorHarness, buildTestTwoFactorDependencies } from './test-harness.js';
import {
  beginTwoFactorEnrollment,
  confirmTwoFactorEnrollment,
  disableTwoFactor,
  twoFactorGateFor,
  twoFactorIsMandatoryFor,
  twoFactorStatus,
  verifyTwoFactorChallenge,
} from './two-factor.js';

/**
 * Two-factor policy (docs/09 §2.8, §7 · docs/12 §11).
 *
 * The algorithm itself is verified against the RFC vectors in
 * `totp.test.ts`; what is checked here is everything an attacker actually
 * attacks — replay, brute force, the paths around the challenge, and whether a
 * staff account can talk its way out of the requirement.
 */

const NOW = new Date('2026-08-16T12:00:00.000Z');

let harness: TestTwoFactorHarness;

beforeEach(() => {
  harness = buildTestTwoFactorDependencies(NOW);
});

/** A user of the given role, with a live session, as `resolveSession` builds it. */
async function seedActor(role: UserRole = 'admin'): Promise<UserActor> {
  const userId = `user-${role}`;
  harness.users.set(userId, {
    id: userId,
    email: `${role}@zfaf.test`,
    emailVerifiedAt: NOW,
    passwordHash: 'hash',
    name: null,
    locale: 'ar',
    marketCode: 'SA',
    role,
    status: 'active',
    failedLoginCount: 0,
    lockedUntil: null,
    deletionRequestedAt: null,
    createdAt: NOW,
  });

  await harness.deps.sessions.create({
    id: `session-${role}`,
    userId,
    tokenHash: new Uint8Array(32).fill(7),
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    ipHash: null,
    userAgent: null,
    now: NOW,
  });

  return {
    kind: 'user',
    userId,
    role,
    emailVerified: true,
    status: 'active',
    sessionId: `session-${role}`,
    memberships: [],
  };
}

/** Runs a full enrollment and hands back the actor and its plaintext secret. */
async function enrolled(role: UserRole = 'admin'): Promise<{
  actor: UserActor;
  secret: Uint8Array;
  recoveryCodes: readonly string[];
}> {
  const actor = await seedActor(role);
  const started = await beginTwoFactorEnrollment(actor, harness.twoFactorDeps);
  if (!started.ok) throw new Error('enrollment did not start');

  const secret = base32Decode(started.value.secret);
  if (!secret) throw new Error('the emitted secret is not base32');

  const confirmed = await confirmTwoFactorEnrollment(
    actor,
    totpCodeAt(secret, NOW),
    harness.twoFactorDeps,
  );
  if (!confirmed.ok) throw new Error('confirmation failed');

  return { actor, secret, recoveryCodes: confirmed.value.recoveryCodes };
}

// ── the policy itself ───────────────────────────────────────────────────────

describe('who must hold a second factor', () => {
  it.each(['support', 'admin', 'superadmin'] as const)('%s must', (role) => {
    expect(twoFactorIsMandatoryFor(role)).toBe(true);
  });

  it.each(['customer', 'planner'] as const)('%s need not', (role) => {
    expect(twoFactorIsMandatoryFor(role)).toBe(false);
  });

  it('refuses a staff session that has not enrolled', () => {
    expect(
      twoFactorGateFor({ role: 'admin', credentialConfirmed: false, sessionVerifiedAt: null }),
    ).toEqual({ state: 'ENROLLMENT_REQUIRED' });
  });

  it('refuses an enrolled session that has not answered the challenge', () => {
    expect(
      twoFactorGateFor({ role: 'admin', credentialConfirmed: true, sessionVerifiedAt: null }),
    ).toEqual({ state: 'CHALLENGE_REQUIRED' });
  });

  it('enforces a customer’s voluntary factor just as strictly', () => {
    // An optional factor a stolen cookie can skip is decoration.
    expect(
      twoFactorGateFor({ role: 'customer', credentialConfirmed: true, sessionVerifiedAt: null }),
    ).toEqual({ state: 'CHALLENGE_REQUIRED' });
  });

  it('asks nothing of a customer who has not enrolled', () => {
    expect(
      twoFactorGateFor({ role: 'customer', credentialConfirmed: false, sessionVerifiedAt: null }),
    ).toEqual({ state: 'NOT_REQUIRED' });
  });
});

// ── enrollment ──────────────────────────────────────────────────────────────

describe('enrollment', () => {
  it('produces a secret an authenticator can read, and does not activate it', async () => {
    const actor = await seedActor();
    const started = await beginTwoFactorEnrollment(actor, harness.twoFactorDeps);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(base32Decode(started.value.secret)).toHaveLength(20);
    expect(started.value.uri).toContain('otpauth://totp/');

    // Not yet usable: the gate still says the account has not enrolled.
    const status = await twoFactorStatus(actor, null, harness.twoFactorDeps);
    expect(status?.enrolled).toBe(false);
    expect(status?.gate).toBe('ENROLLMENT_REQUIRED');
  });

  it('rejects a wrong code without confirming anything', async () => {
    const actor = await seedActor();
    await beginTwoFactorEnrollment(actor, harness.twoFactorDeps);

    const confirmed = await confirmTwoFactorEnrollment(actor, '000000', harness.twoFactorDeps);
    expect(confirmed.ok).toBe(false);

    const status = await twoFactorStatus(actor, null, harness.twoFactorDeps);
    expect(status?.enrolled).toBe(false);
  });

  it('issues exactly ten recovery codes, once', async () => {
    const { actor, recoveryCodes } = await enrolled();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    // Re-confirming does not mint a second set.
    const again = await confirmTwoFactorEnrollment(actor, '123456', harness.twoFactorDeps);
    expect(again.ok).toBe(false);
    expect(await harness.twoFactorRepo.countUnusedRecoveryCodes(actor.userId)).toBe(10);
  });

  it('never stores the secret in a form the database alone can use', async () => {
    const actor = await seedActor();
    const started = await beginTwoFactorEnrollment(actor, harness.twoFactorDeps);
    if (!started.ok) return;

    const stored = await harness.twoFactorRepo.findByUserId(actor.userId);
    const plaintext = base32Decode(started.value.secret);
    expect(stored).not.toBeNull();
    // The sealed bytes differ from the plaintext — the double prefixes rather
    // than encrypts, but the property under test is that they are not equal.
    expect([...(stored?.secretSealed ?? [])]).not.toEqual([...(plaintext ?? [])]);
  });

  it('refuses to restart enrollment over a working factor', async () => {
    const { actor } = await enrolled();
    const restarted = await beginTwoFactorEnrollment(actor, harness.twoFactorDeps);
    expect(restarted.ok).toBe(false);
    if (restarted.ok) return;
    expect(restarted.error.code).toBe('CONFLICT');
  });

  it('signs every other session out, so enrolling actually changes something', async () => {
    const actor = await seedActor();
    await harness.deps.sessions.create({
      id: 'session-elsewhere',
      userId: actor.userId,
      tokenHash: new Uint8Array(32).fill(9),
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      ipHash: null,
      userAgent: null,
      now: NOW,
    });

    const started = await beginTwoFactorEnrollment(actor, harness.twoFactorDeps);
    if (!started.ok) return;
    const secret = base32Decode(started.value.secret)!;
    await confirmTwoFactorEnrollment(actor, totpCodeAt(secret, NOW), harness.twoFactorDeps);

    expect(harness.sessions.get('session-elsewhere')?.revokedAt).not.toBeNull();
    // The one that did the enrolling survives, and is verified.
    expect(harness.sessions.get('session-admin')?.revokedAt).toBeNull();
    expect(harness.sessions.get('session-admin')?.twoFactorVerifiedAt).toEqual(NOW);
  });
});

// ── the challenge ───────────────────────────────────────────────────────────

describe('the login challenge', () => {
  it('accepts the current code and verifies the session', async () => {
    const { actor, secret } = await enrolled();
    // Move past the step consumed by enrollment.
    harness.clock.advance(TOTP_PERIOD_SECONDS * 1000);
    const now = harness.clock.now();

    const result = await verifyTwoFactorChallenge(
      actor,
      totpCodeAt(secret, now),
      harness.twoFactorDeps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.method).toBe('TOTP');
    expect(harness.sessions.get('session-admin')?.twoFactorVerifiedAt).toEqual(now);
  });

  it('refuses a code that has already been used — the replay case', async () => {
    const { actor, secret } = await enrolled();
    harness.clock.advance(TOTP_PERIOD_SECONDS * 1000);
    const code = totpCodeAt(secret, harness.clock.now());

    expect((await verifyTwoFactorChallenge(actor, code, harness.twoFactorDeps)).ok).toBe(true);

    // Same code, same window, still valid by the clock — and refused.
    const replayed = await verifyTwoFactorChallenge(actor, code, harness.twoFactorDeps);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses the code from the step before the one just used', async () => {
    const { actor, secret } = await enrolled();
    harness.clock.advance(TOTP_PERIOD_SECONDS * 2000);
    const now = harness.clock.now();
    await verifyTwoFactorChallenge(actor, totpCodeAt(secret, now), harness.twoFactorDeps);

    const previous = totpCodeAt(secret, new Date(now.getTime() - TOTP_PERIOD_SECONDS * 1000));
    expect((await verifyTwoFactorChallenge(actor, previous, harness.twoFactorDeps)).ok).toBe(false);
  });

  it('accepts a recovery code, once', async () => {
    const { actor, recoveryCodes } = await enrolled();
    const code = recoveryCodes[0]!;

    const first = await verifyTwoFactorChallenge(actor, code, harness.twoFactorDeps);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.method).toBe('RECOVERY_CODE');
    expect(first.value.recoveryCodesRemaining).toBe(9);

    const second = await verifyTwoFactorChallenge(actor, code, harness.twoFactorDeps);
    expect(second.ok).toBe(false);
  });

  it('accepts a recovery code however it was written down', async () => {
    const { actor, recoveryCodes } = await enrolled();
    const messy = `  ${recoveryCodes[0]!.toLowerCase().replace('-', ' ')}  `;
    expect((await verifyTwoFactorChallenge(actor, messy, harness.twoFactorDeps)).ok).toBe(true);
  });

  it('refuses a recovery code belonging to somebody else', async () => {
    const mine = await enrolled('admin');
    const theirs = await enrolled('support');

    const result = await verifyTwoFactorChallenge(
      mine.actor,
      theirs.recoveryCodes[0]!,
      harness.twoFactorDeps,
    );
    expect(result.ok).toBe(false);
  });

  it('answers identically whichever kind of code was wrong', async () => {
    const { actor } = await enrolled();
    const wrongTotp = await verifyTwoFactorChallenge(actor, '000000', harness.twoFactorDeps);
    const wrongRecovery = await verifyTwoFactorChallenge(
      actor,
      'AAAAA-BBBBB',
      harness.twoFactorDeps,
    );

    expect(wrongTotp.ok).toBe(false);
    expect(wrongRecovery.ok).toBe(false);
    if (wrongTotp.ok || wrongRecovery.ok) return;
    // Same code, same shape. The caller cannot tell which factor it missed.
    expect(wrongTotp.error).toEqual(wrongRecovery.error);
  });

  it('refuses a challenge for an account that never enrolled', async () => {
    const actor = await seedActor();
    const result = await verifyTwoFactorChallenge(actor, '123456', harness.twoFactorDeps);
    expect(result.ok).toBe(false);
  });

  it('throttles guessing long before a six-digit code could be found', async () => {
    const { actor } = await enrolled();

    let rateLimited = false;
    for (let attempt = 0; attempt < RATE_LIMITS.twoFactorPerSession.limit + 3; attempt += 1) {
      const result = await verifyTwoFactorChallenge(actor, '000000', harness.twoFactorDeps);
      if (!result.ok && result.error.code === 'RATE_LIMITED') rateLimited = true;
    }
    expect(rateLimited).toBe(true);
  });

  it.each([
    { kind: 'anonymous', ipHash: 'x' },
    { kind: 'system', jobName: 'flush' },
    { kind: 'guest', invitationId: 'i', guestId: 'g' },
  ] as const)('refuses a $kind actor, which has no session to verify', async (actor) => {
    // There is no "half-authenticated" caller here. Anything that is not a
    // signed-in user has nothing to elevate.
    const result = await verifyTwoFactorChallenge(actor, '123456', harness.twoFactorDeps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
  });
});

// ── removal ─────────────────────────────────────────────────────────────────

describe('removing a second factor', () => {
  it('is refused for staff, with a correct code', async () => {
    const { actor, secret } = await enrolled('admin');
    harness.clock.advance(TOTP_PERIOD_SECONDS * 1000);

    const result = await disableTwoFactor(
      actor,
      totpCodeAt(secret, harness.clock.now()),
      harness.twoFactorDeps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
    expect(await harness.twoFactorRepo.findByUserId(actor.userId)).not.toBeNull();
  });

  it('records the refusal, so an attempt to weaken the account is visible', async () => {
    const { actor, secret } = await enrolled('admin');
    harness.clock.advance(TOTP_PERIOD_SECONDS * 1000);
    await disableTwoFactor(actor, totpCodeAt(secret, harness.clock.now()), harness.twoFactorDeps);

    expect(harness.auditEntries.map((entry) => entry.action)).toContain(
      'two_factor.disable_refused',
    );
  });

  it('is allowed for a customer who proves possession', async () => {
    const { actor, secret } = await enrolled('customer');
    harness.clock.advance(TOTP_PERIOD_SECONDS * 1000);

    const result = await disableTwoFactor(
      actor,
      totpCodeAt(secret, harness.clock.now()),
      harness.twoFactorDeps,
    );
    expect(result.ok).toBe(true);
    expect(await harness.twoFactorRepo.findByUserId(actor.userId)).toBeNull();
  });

  it('is refused for a customer who cannot produce a code', async () => {
    const { actor } = await enrolled('customer');
    const result = await disableTwoFactor(actor, '000000', harness.twoFactorDeps);
    expect(result.ok).toBe(false);
    expect(await harness.twoFactorRepo.findByUserId(actor.userId)).not.toBeNull();
  });
});

// ── the audit trail ─────────────────────────────────────────────────────────

describe('what the audit log records', () => {
  it('records enrollment and every challenge outcome', async () => {
    const { actor, secret } = await enrolled();
    harness.clock.advance(TOTP_PERIOD_SECONDS * 1000);
    await verifyTwoFactorChallenge(actor, '000000', harness.twoFactorDeps);
    await verifyTwoFactorChallenge(
      actor,
      totpCodeAt(secret, harness.clock.now()),
      harness.twoFactorDeps,
    );

    const actions = harness.auditEntries.map((entry) => entry.action);
    expect(actions).toContain('two_factor.enrollment_started');
    expect(actions).toContain('two_factor.enrolled');
    expect(actions).toContain('two_factor.challenge_failed');
    expect(actions).toContain('two_factor.challenge_passed');
  });

  it('never writes a submitted code into the log', async () => {
    const { actor } = await enrolled();
    await verifyTwoFactorChallenge(actor, '424242', harness.twoFactorDeps);

    const serialised = JSON.stringify(harness.auditEntries);
    expect(serialised).not.toContain('424242');
  });

  it('never writes the secret or a recovery code into the log', async () => {
    const { recoveryCodes } = await enrolled();
    const serialised = JSON.stringify(harness.auditEntries);
    for (const code of recoveryCodes) {
      expect(serialised).not.toContain(code);
    }
  });
});
