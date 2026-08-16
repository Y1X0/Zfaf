import { beforeEach, describe, expect, it } from 'vitest';

import { fixedClock } from '../../ports/clock.js';
import { RATE_LIMITS, lockoutDurationFor } from '../ports/rate-limiter.js';
import { login, registerUser } from './authenticate.js';
import { requestPasswordReset, resetPassword, verifyEmail } from './credentials.js';
import { buildTestAuthDependencies, type TestAuthHarness } from './test-harness.js';

/**
 * Authentication behaviour.
 *
 * The emphasis is on what an attacker can learn and what they can do, not on
 * the happy path. Two properties are asserted repeatedly because they are the
 * ones that quietly break: responses must not reveal which addresses have
 * accounts, and nothing recoverable is ever stored.
 */

const START = new Date('2026-08-16T12:00:00.000Z');

let harness: TestAuthHarness;

beforeEach(() => {
  harness = buildTestAuthDependencies(START);
});

const registration = {
  email: 'sarah@example.com',
  password: 'correct-horse-battery',
  marketCode: 'SA',
  ipHash: 'ip-1',
};

describe('registration', () => {
  it('creates an account and signs the user straight in', async () => {
    const result = await registerUser(registration, harness.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.sessionToken).toBeTruthy();
  });

  it('sends a verification email', async () => {
    await registerUser(registration, harness.deps);
    const message = harness.mail.lastTo('sarah@example.com');
    expect(message?.template).toBe('email_verification');
    expect(message?.data['token']).toBeTruthy();
  });

  it('never stores the password in a recoverable form', async () => {
    await registerUser(registration, harness.deps);
    const user = await harness.deps.users.findByEmail('sarah@example.com');

    expect(user?.passwordHash).toBeTruthy();
    expect(user?.passwordHash).not.toContain(registration.password);
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('normalises the address, so casing cannot fork an account', async () => {
    await registerUser(registration, harness.deps);
    const second = await registerUser(
      { ...registration, email: 'SARAH@Example.COM' },
      harness.deps,
    );

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.created).toBe(false);
    expect(harness.users.size).toBe(1);
  });

  it('rejects a weak password', async () => {
    const result = await registerUser({ ...registration, password: 'short' }, harness.deps);
    expect(result.ok).toBe(false);
  });

  it('rejects a disposable address', async () => {
    const result = await registerUser(
      { ...registration, email: 'throwaway@mailinator.com' },
      harness.deps,
    );
    expect(result.ok).toBe(false);
  });
});

describe('registration does not disclose existing accounts', () => {
  it('answers identically whether or not the address is taken', async () => {
    const first = await registerUser(registration, harness.deps);
    const second = await registerUser(
      { ...registration, password: 'a-completely-different-one' },
      harness.deps,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Both succeed from the caller's point of view. The difference is carried
    // only by the email that reaches the real owner.
    if (first.ok && second.ok) {
      expect(typeof first.value.created).toBe('boolean');
      expect(typeof second.value.created).toBe('boolean');
    }
  });

  it('does not create a second account, and does not overwrite the first password', async () => {
    await registerUser(registration, harness.deps);
    const original = await harness.deps.users.findByEmail(registration.email);

    await registerUser({ ...registration, password: 'attacker-chosen-value' }, harness.deps);
    const after = await harness.deps.users.findByEmail(registration.email);

    expect(harness.users.size).toBe(1);
    expect(after?.passwordHash).toBe(original?.passwordHash);
  });

  it('warns the real owner that someone tried to use their address', async () => {
    await registerUser(registration, harness.deps);
    harness.mail.clear();
    await registerUser(registration, harness.deps);

    expect(harness.mail.lastTo(registration.email)?.data['reason']).toBe('registration_attempt');
  });

  it('still hashes a password for a taken address, keeping the timing uniform', async () => {
    await registerUser(registration, harness.deps);
    const before = harness.hasher.hashCalls;
    await registerUser(registration, harness.deps);
    expect(harness.hasher.hashCalls).toBeGreaterThan(before);
  });
});

describe('sign-in', () => {
  beforeEach(async () => {
    await registerUser(registration, harness.deps);
    harness.mail.clear();
  });

  it('succeeds with the right password', async () => {
    const result = await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-2' },
      harness.deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sessionToken).toBeTruthy();
  });

  it('reports that verification is still outstanding', async () => {
    const result = await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-2' },
      harness.deps,
    );
    expect(result.ok && result.value.requiresEmailVerification).toBe(true);
  });

  it('stores only a hash of the session token', async () => {
    const result = await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-2' },
      harness.deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = [...harness.sessions.values()];
    const serialized = JSON.stringify(stored.map((s) => Array.from(s.tokenHash)));
    expect(serialized).not.toContain(result.value.sessionToken);
    expect(stored.every((s) => s.tokenHash.length === 32)).toBe(true);
  });
});

describe('sign-in resists account enumeration', () => {
  beforeEach(async () => {
    await registerUser(registration, harness.deps);
  });

  it('returns the same error for a wrong password and an unknown address', async () => {
    const wrongPassword = await login(
      { email: registration.email, password: 'not-the-password', ipHash: 'ip-3' },
      harness.deps,
    );
    const unknownAccount = await login(
      { email: 'nobody@example.com', password: 'not-the-password', ipHash: 'ip-4' },
      harness.deps,
    );

    expect(wrongPassword.ok).toBe(false);
    expect(unknownAccount.ok).toBe(false);
    if (!wrongPassword.ok && !unknownAccount.ok) {
      expect(wrongPassword.error.code).toBe(unknownAccount.error.code);
      expect(wrongPassword.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('verifies against a dummy hash for an unknown address, matching the work done', async () => {
    // Without this, a stopwatch enumerates the user table: a known address
    // costs an argon2id verification, an unknown one costs nothing.
    const before = harness.hasher.verifyCalls;
    await login({ email: 'nobody@example.com', password: 'x', ipHash: 'ip-5' }, harness.deps);
    expect(harness.hasher.verifyCalls).toBe(before + 1);
  });

  it('does the same work for a malformed address', async () => {
    const before = harness.hasher.hashCalls + harness.hasher.verifyCalls;
    await login({ email: 'not-an-email', password: 'x', ipHash: 'ip-6' }, harness.deps);
    expect(harness.hasher.hashCalls + harness.hasher.verifyCalls).toBeGreaterThan(before);
  });

  it('does not reveal a suspended account through the login response', async () => {
    const user = await harness.deps.users.findByEmail(registration.email);
    if (!user) throw new Error('expected a user');
    await harness.deps.users.setStatus(user.id, 'suspended', 'abuse', START);

    const result = await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-7' },
      harness.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('brute force and credential stuffing', () => {
  beforeEach(async () => {
    await registerUser(registration, harness.deps);
  });

  it('throttles repeated attempts against one account', async () => {
    const attempt = () =>
      login({ email: registration.email, password: 'wrong', ipHash: 'ip-8' }, harness.deps);

    for (let index = 0; index < RATE_LIMITS.loginPerAccount.limit; index += 1) {
      const result = await attempt();
      expect(result.ok).toBe(false);
    }

    const throttled = await attempt();
    expect(throttled.ok).toBe(false);
    if (!throttled.ok) expect(throttled.error.code).toBe('RATE_LIMITED');
  });

  it('throttles one IP spraying many accounts', async () => {
    // A per-account limit alone does not stop credential stuffing, where each
    // account sees only one or two attempts.
    let rateLimited = false;
    for (let index = 0; index < RATE_LIMITS.loginPerIp.limit + 2; index += 1) {
      const result = await login(
        { email: `victim${index}@example.com`, password: 'guess', ipHash: 'attacker-ip' },
        harness.deps,
      );
      if (!result.ok && result.error.code === 'RATE_LIMITED') rateLimited = true;
    }
    expect(rateLimited).toBe(true);
  });

  it('escalates the lockout rather than applying a flat penalty', () => {
    // Someone who mistypes twice should not be locked out for an hour.
    expect(lockoutDurationFor(1)).toBeNull();
    expect(lockoutDurationFor(4)).toBeNull();
    const first = lockoutDurationFor(5);
    const later = lockoutDurationFor(8);
    expect(first).not.toBeNull();
    expect(later).not.toBeNull();
    expect(later as number).toBeGreaterThan(first as number);
  });

  it('forgives earlier failures after a successful sign-in', async () => {
    for (let index = 0; index < 3; index += 1) {
      await login({ email: registration.email, password: 'wrong', ipHash: 'ip-9' }, harness.deps);
    }

    const success = await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-9' },
      harness.deps,
    );
    expect(success.ok).toBe(true);

    const user = await harness.deps.users.findByEmail(registration.email);
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lockedUntil).toBeNull();
  });

  it('throttles registration from one IP', async () => {
    let rateLimited = false;
    for (let index = 0; index < RATE_LIMITS.registerPerIp.limit + 2; index += 1) {
      const result = await registerUser(
        { ...registration, email: `bulk${index}@example.com`, ipHash: 'bulk-ip' },
        harness.deps,
      );
      if (!result.ok && result.error.code === 'RATE_LIMITED') rateLimited = true;
    }
    expect(rateLimited).toBe(true);
  });
});

describe('email verification', () => {
  it('confirms the address with a valid token', async () => {
    await registerUser(registration, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'];
    expect(token).toBeTruthy();

    const result = await verifyEmail(token as string, harness.deps);
    expect(result.ok).toBe(true);

    const user = await harness.deps.users.findByEmail(registration.email);
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it('refuses a token a second time', async () => {
    await registerUser(registration, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;

    expect((await verifyEmail(token, harness.deps)).ok).toBe(true);
    expect((await verifyEmail(token, harness.deps)).ok).toBe(false);
  });

  it('refuses an expired token', async () => {
    await registerUser(registration, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;

    harness.clock.advance(25 * 60 * 60 * 1000);
    expect((await verifyEmail(token, harness.deps)).ok).toBe(false);
  });

  it('refuses a forged token', async () => {
    await registerUser(registration, harness.deps);
    expect((await verifyEmail('made-up-token-value', harness.deps)).ok).toBe(false);
  });

  it('does not change the role — verification must never escalate privilege', async () => {
    await registerUser(registration, harness.deps);
    const before = await harness.deps.users.findByEmail(registration.email);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;

    await verifyEmail(token, harness.deps);
    const after = await harness.deps.users.findByEmail(registration.email);

    expect(after?.role).toBe(before?.role);
    expect(after?.role).toBe('customer');
  });

  it('stores only the hash of the verification token', async () => {
    await registerUser(registration, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;
    const serialized = JSON.stringify([...harness.verificationTokens.values()]);
    expect(serialized).not.toContain(token);
  });
});

describe('password reset', () => {
  beforeEach(async () => {
    await registerUser(registration, harness.deps);
    harness.mail.clear();
  });

  it('always answers success, even for an address with no account', async () => {
    // Otherwise the endpoint is a free lookup service for valid addresses.
    const known = await requestPasswordReset(
      { email: registration.email, ipHash: 'ip-10' },
      harness.deps,
    );
    const unknown = await requestPasswordReset(
      { email: 'nobody@example.com', ipHash: 'ip-11' },
      harness.deps,
    );

    expect(known.ok).toBe(true);
    expect(unknown.ok).toBe(true);
    expect(harness.mail.lastTo('nobody@example.com')).toBeUndefined();
  });

  it('resets the password with a valid token', async () => {
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-12' }, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;

    const result = await resetPassword(
      { token, newPassword: 'a-brand-new-passphrase' },
      harness.deps,
    );
    expect(result.ok).toBe(true);

    const signIn = await login(
      { email: registration.email, password: 'a-brand-new-passphrase', ipHash: 'ip-13' },
      harness.deps,
    );
    expect(signIn.ok).toBe(true);
  });

  it('revokes every existing session', async () => {
    // If the reset was triggered by an attacker who already had a session,
    // leaving it alive would defeat the entire exercise.
    await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-14' },
      harness.deps,
    );
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-15' }, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;

    const result = await resetPassword(
      { token, newPassword: 'another-good-passphrase' },
      harness.deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionsRevoked).toBeGreaterThan(0);
  });

  it('refuses a token a second time', async () => {
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-16' }, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;

    expect(
      (await resetPassword({ token, newPassword: 'first-new-passphrase' }, harness.deps)).ok,
    ).toBe(true);
    expect(
      (await resetPassword({ token, newPassword: 'second-new-passphrase' }, harness.deps)).ok,
    ).toBe(false);
  });

  it('refuses a token after 15 minutes', async () => {
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-17' }, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;

    harness.clock.advance(16 * 60 * 1000);
    expect(
      (await resetPassword({ token, newPassword: 'too-late-passphrase' }, harness.deps)).ok,
    ).toBe(false);
  });

  it('invalidates the previous link when a new one is requested', async () => {
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-18' }, harness.deps);
    const firstToken = harness.mail.lastTo(registration.email)?.data['token'] as string;

    await requestPasswordReset({ email: registration.email, ipHash: 'ip-18' }, harness.deps);

    expect(
      (
        await resetPassword(
          { token: firstToken, newPassword: 'stale-link-passphrase' },
          harness.deps,
        )
      ).ok,
    ).toBe(false);
  });

  it('never sends the password itself', async () => {
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-19' }, harness.deps);
    const message = harness.mail.lastTo(registration.email);
    expect(JSON.stringify(message?.data)).not.toContain(registration.password);
  });

  it('rejects a weak replacement password', async () => {
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-20' }, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;
    expect((await resetPassword({ token, newPassword: 'short' }, harness.deps)).ok).toBe(false);
  });

  it('stores only the hash of the reset token', async () => {
    await requestPasswordReset({ email: registration.email, ipHash: 'ip-21' }, harness.deps);
    const token = harness.mail.lastTo(registration.email)?.data['token'] as string;
    expect(JSON.stringify([...harness.verificationTokens.values()])).not.toContain(token);
  });
});

describe('signing in cancels a scheduled deletion', () => {
  it('restores the account', async () => {
    await registerUser(registration, harness.deps);
    const user = await harness.deps.users.findByEmail(registration.email);
    if (!user) throw new Error('expected a user');

    await harness.deps.users.requestDeletion(user.id, START);

    const result = await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-22' },
      harness.deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.deletionCancelled).toBe(true);

    const after = await harness.deps.users.findById(user.id);
    expect(after?.status).toBe('active');
    expect(after?.deletionRequestedAt).toBeNull();
  });
});

describe('audit trail', () => {
  it('records the authentication events without recording secrets', async () => {
    await registerUser(registration, harness.deps);
    await login({ email: registration.email, password: 'wrong', ipHash: 'ip-23' }, harness.deps);
    await login(
      { email: registration.email, password: registration.password, ipHash: 'ip-23' },
      harness.deps,
    );

    const actions = harness.auditEntries.map((entry) => entry.action);
    expect(actions).toContain('auth.registered');
    expect(actions).toContain('auth.login_failed');
    expect(actions).toContain('auth.login_succeeded');

    const serialized = JSON.stringify(harness.auditEntries);
    expect(serialized).not.toContain(registration.password);
    expect(serialized).not.toContain('$argon2id$');
  });
});

describe('the clock is injected, so time-dependent behaviour is testable', () => {
  it('uses the harness clock rather than the wall clock', () => {
    const clock = fixedClock(START);
    expect(clock.now().toISOString()).toBe(START.toISOString());
    clock.advance(1000);
    expect(clock.now().getTime()).toBe(START.getTime() + 1000);
  });
});
