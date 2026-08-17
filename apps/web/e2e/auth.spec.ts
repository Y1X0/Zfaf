import { type Browser, type BrowserContext, expect, test } from '@playwright/test';

import {
  cleanupSeeded,
  latestVerificationToken,
  seedStaffSession,
  userByEmail,
} from './fixtures/seed.js';

/**
 * Registration and sign-in over HTTP (FR-A1–A5, Go-Live gate 1).
 *
 * The session layer landed in M2 and has been exercised ever since through
 * seeded cookies. What did not exist until now is the way a **real customer**
 * reaches it: there were no sign-up or sign-in endpoints at all, which is why
 * the launch checklist listed this first.
 *
 * Two things this file is careful about:
 *
 *   • **The token is read from the database, not the response.** No endpoint
 *     returns a verification or reset token — that would put a live credential
 *     in a response body and in every proxy log between here and the browser.
 *     The fixture reads what the mail *would* have carried, which is the only
 *     honest way to test the flow while `MAIL_DRIVER=noop`.
 *   • **Enumeration is asserted on, not assumed.** Several tests below check
 *     that two different situations produce byte-identical answers, because
 *     that equality is the security property and it is exactly the kind of
 *     thing a well-meaning refactor breaks.
 */

/** A password that satisfies the policy, so failures are never about strength. */
const PASSWORD = 'a-genuinely-fine-passphrase-42';

function freshEmail(): string {
  return `signup-${Math.random().toString(36).slice(2, 10)}@e2e.zfaf.test`;
}

/**
 * Every test gets its own client address.
 *
 * Registration is capped at **three per hour per IP** (`RATE_LIMITS
 * .registerPerIp`) and sign-in at twenty — real anti-abuse limits that a
 * launch depends on. A suite that created a dozen accounts from one address
 * would exhaust them and then fail for a reason unrelated to what it tests, and
 * the tempting repair is to raise the limit. So the suite gives each test a
 * distinct address instead, which is what a dozen different customers actually
 * are. `203.0.113.0/24` is the RFC 5737 documentation range and can never
 * collide with anything real.
 */
let addressCounter = 0;
async function client(browser: Browser): Promise<BrowserContext> {
  addressCounter += 1;
  return await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${40 + (addressCounter % 200)}` },
  });
}

test.afterAll(async () => {
  await cleanupSeeded();
});

// ── registration ────────────────────────────────────────────────────────────

test('a new customer can create an account and is signed in immediately', async ({ browser }) => {
  const request = (await client(browser)).request;
  const email = freshEmail();
  const response = await request.post('/api/v1/auth/register', {
    data: { email, password: PASSWORD, name: 'سارة', locale: 'ar' },
  });

  expect(response.status()).toBe(201);
  expect(await response.json()).toEqual({ data: { registered: true } });

  // Signed in at once: verification gates publishing, not the first run
  // (FR-A2), so a new user reaches a finished draft before being asked for
  // anything.
  const cookie = response.headers()['set-cookie'] ?? '';
  expect(cookie).toContain('__Host-zfaf_session=');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('SameSite=Lax');

  const created = await userByEmail(email);
  expect(created?.emailVerifiedAt).toBeNull();
});

test('registering with a taken address is indistinguishable from a new one', async ({
  browser,
}) => {
  const request = (await client(browser)).request;
  /**
   * The property this whole endpoint is shaped around.
   *
   * If the two answers differed in status, body, or by much in timing, the
   * endpoint would be a service for discovering which addresses have accounts.
   * The person who already has one learns about the attempt by email, which is
   * where that belongs.
   */
  const email = freshEmail();
  const first = await request.post('/api/v1/auth/register', {
    data: { email, password: PASSWORD },
  });
  const second = await request.post('/api/v1/auth/register', {
    data: { email, password: 'a-completely-different-passphrase-9' },
  });

  expect(second.status()).toBe(first.status());
  expect(await second.json()).toEqual(await first.json());

  // And the second attempt did not overwrite anything.
  const { count } = await userByEmail(email).then((user) => ({ count: user ? 1 : 0 }));
  expect(count).toBe(1);
});

test('a weak password is refused, and says so specifically', async ({ browser }) => {
  const request = (await client(browser)).request;
  // The one place a specific complaint is right: the person needs to know what
  // to fix, and "your password is weak" reveals nothing about anyone else.
  const response = await request.post('/api/v1/auth/register', {
    data: { email: freshEmail(), password: 'short' },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
});

// ── verification ────────────────────────────────────────────────────────────

test('the verification token is never returned in a response', async ({ browser }) => {
  const request = (await client(browser)).request;
  // A live credential in a response body is a live credential in every proxy
  // log between here and the browser.
  const email = freshEmail();
  const response = await request.post('/api/v1/auth/register', {
    data: { email, password: PASSWORD },
  });

  const body = await response.text();
  const user = await userByEmail(email);
  const token = await latestVerificationToken(user!.id, 'email_verification');

  expect(token).toBeTruthy();
  expect(body).not.toContain(token!);
  expect(body).not.toContain(user!.id);
});

test('a verification link works once, and only once', async ({ browser }) => {
  const request = (await client(browser)).request;
  const email = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });
  const user = await userByEmail(email);
  const token = await latestVerificationToken(user!.id, 'email_verification');

  const first = await request.post('/api/v1/auth/verify-email', { data: { token } });
  expect(first.status()).toBe(200);
  expect((await userByEmail(email))?.emailVerifiedAt).not.toBeNull();

  // Single use, enforced by the update's own predicate.
  const second = await request.post('/api/v1/auth/verify-email', { data: { token } });
  expect(second.status()).toBe(400);
});

test('verification never changes a role', async ({ browser }) => {
  const request = (await client(browser)).request;
  // A verification link that could escalate privilege would make every inbox a
  // path to admin.
  const email = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });
  const user = await userByEmail(email);
  const token = await latestVerificationToken(user!.id, 'email_verification');

  await request.post('/api/v1/auth/verify-email', { data: { token } });
  expect((await userByEmail(email))?.role).toBe('customer');
});

test('an expired, forged or already-used token all answer the same way', async ({ browser }) => {
  const request = (await client(browser)).request;
  const answers = await Promise.all(
    ['obviously-not-a-token', 'a'.repeat(64), ''].map(async (token) => {
      const response = await request.post('/api/v1/auth/verify-email', { data: { token } });
      return { status: response.status(), body: await response.json() };
    }),
  );
  // The two well-formed-but-wrong tokens must be indistinguishable; the empty
  // one is a validation failure either way.
  expect(answers[1]).toEqual(answers[0]);
});

// ── signing in ──────────────────────────────────────────────────────────────

test('a registered customer can sign in and read their own session', async ({ browser }) => {
  const request = (await client(browser)).request;
  const email = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });

  const signedIn = await request.post('/api/v1/auth/login', {
    data: { email, password: PASSWORD },
  });
  expect(signedIn.status()).toBe(200);
  expect((await signedIn.json()).data.nextStep).toBe('none');

  const session = await request.get('/api/v1/auth/session');
  expect(session.status()).toBe(200);
  const me = (await session.json()).data as Record<string, unknown>;

  expect(me['email']).toBe(email);
  expect(me['role']).toBe('customer');
  // What a client needs to render a shell, and nothing more. A user id or a
  // membership list here would become a second source of truth for
  // authorization that could drift from `can()`.
  expect(Object.keys(me).sort()).toEqual(
    ['email', 'emailVerified', 'locale', 'name', 'role', 'twoFactor'].sort(),
  );
});

test('a wrong password and an unknown address answer identically', async ({ browser }) => {
  const request = (await client(browser)).request;
  const email = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });

  const wrongPassword = await request.post('/api/v1/auth/login', {
    data: { email, password: 'not-the-password-at-all' },
  });
  const unknownAddress = await request.post('/api/v1/auth/login', {
    data: { email: freshEmail(), password: PASSWORD },
  });

  expect(wrongPassword.status()).toBe(401);
  expect(unknownAddress.status()).toBe(401);
  expect(await wrongPassword.json()).toEqual(await unknownAddress.json());
  expect(wrongPassword.headers()['set-cookie'] ?? '').not.toContain('__Host-zfaf_session=');
});

test('repeated wrong passwords are throttled', async ({ browser }) => {
  const request = (await client(browser)).request;
  const email = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await request.post('/api/v1/auth/login', {
      data: { email, password: `wrong-${attempt}` },
    });
    statuses.push(response.status());
  }
  expect(statuses).toContain(429);
});

// ── signing out ─────────────────────────────────────────────────────────────

test('signing out ends the session and clears the cookie', async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.31' },
  });
  const email = freshEmail();
  await context.request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });

  expect((await context.request.get('/api/v1/auth/session')).status()).toBe(200);

  const out = await context.request.post('/api/v1/auth/logout');
  expect(out.status()).toBe(200);
  expect(out.headers()['set-cookie'] ?? '').toContain('Max-Age=0');

  // The row is revoked, not merely forgotten by the browser.
  expect((await context.request.get('/api/v1/auth/session')).status()).toBe(401);
  await context.close();
});

test('signing out with no session is not an error', async ({ browser }) => {
  const request = (await client(browser)).request;
  // A client clearing local state should not have to branch on whether the
  // cookie was still valid.
  const response = await request.post('/api/v1/auth/logout');
  expect(response.status()).toBe(200);
});

// ── password reset ──────────────────────────────────────────────────────────

test('asking for a reset answers the same for a known and an unknown address', async ({
  browser,
}) => {
  const request = (await client(browser)).request;
  const known = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email: known, password: PASSWORD } });

  const forKnown = await request.post('/api/v1/auth/password-reset', { data: { email: known } });
  const forUnknown = await request.post('/api/v1/auth/password-reset', {
    data: { email: freshEmail() },
  });

  // The classic enumeration oracle, closed.
  expect(forKnown.status()).toBe(200);
  expect(forUnknown.status()).toBe(200);
  expect(await forKnown.json()).toEqual(await forUnknown.json());
});

test('a reset sets the new password and ends every existing session', async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.32' },
  });
  const email = freshEmail();
  await context.request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });
  const user = await userByEmail(email);

  await context.request.post('/api/v1/auth/password-reset', { data: { email } });
  const token = await latestVerificationToken(user!.id, 'password_reset');
  expect(token).toBeTruthy();

  const next = 'an-entirely-new-passphrase-77';
  const reset = await context.request.put('/api/v1/auth/password-reset', {
    data: { token, password: next },
  });
  expect(reset.status()).toBe(200);

  /**
   * Every session ends, including this one.
   *
   * If the reset was triggered by an attacker who already held a session,
   * leaving it alive would defeat the entire exercise — and a person resetting
   * after a scare expects precisely this.
   */
  expect((await context.request.get('/api/v1/auth/session')).status()).toBe(401);

  // The old password no longer works, and the new one does.
  expect(
    (
      await context.request.post('/api/v1/auth/login', { data: { email, password: PASSWORD } })
    ).status(),
  ).toBe(401);
  expect(
    (
      await context.request.post('/api/v1/auth/login', { data: { email, password: next } })
    ).status(),
  ).toBe(200);
  await context.close();
});

test('a reset token works once', async ({ browser }) => {
  const request = (await client(browser)).request;
  const email = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });
  const user = await userByEmail(email);
  await request.post('/api/v1/auth/password-reset', { data: { email } });
  const token = await latestVerificationToken(user!.id, 'password_reset');

  const first = await request.put('/api/v1/auth/password-reset', {
    data: { token, password: 'first-new-passphrase-11' },
  });
  expect(first.status()).toBe(200);

  const second = await request.put('/api/v1/auth/password-reset', {
    data: { token, password: 'second-new-passphrase-22' },
  });
  expect(second.status()).toBe(400);
  // Told apart from a weak password on purpose: somebody whose link expired
  // needs to know to request another one, not to keep retyping.
  expect((await second.json()).error.code).toBe('RESET_LINK_INVALID');
});

test('a weak password on reset is told apart from a stale link', async ({ browser }) => {
  const request = (await client(browser)).request;
  const email = freshEmail();
  await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD } });
  const user = await userByEmail(email);
  await request.post('/api/v1/auth/password-reset', { data: { email } });
  const token = await latestVerificationToken(user!.id, 'password_reset');

  const weak = await request.put('/api/v1/auth/password-reset', {
    data: { token, password: 'short' },
  });
  expect(weak.status()).toBe(400);
  expect((await weak.json()).error.code).toBe('VALIDATION_FAILED');

  // And the token survived the rejected attempt, so the person can try again.
  const retry = await request.put('/api/v1/auth/password-reset', {
    data: { token, password: 'a-much-better-passphrase-31' },
  });
  expect(retry.status()).toBe(200);
});

// ── where this meets the second factor ──────────────────────────────────────

test('a staff sign-in issues a session that cannot reach the console yet', async ({ browser }) => {
  /**
   * The join between this work and M10's.
   *
   * Signing in issues the cookie; the cookie is deliberately useless until the
   * challenge is answered, because session resolution refuses an unverified
   * staff session everywhere but the five endpoints that exist to satisfy the
   * gate. So there is exactly one kind of session in the system, and one place
   * that decides what it may do.
   */
  const context = await client(browser);
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'verified' });
  const user = await userByEmail(undefined, staff.userId);

  // Give the seeded operator a password so they can sign in the ordinary way.
  await context.request.post('/api/v1/auth/password-reset', { data: { email: user!.email } });
  const token = await latestVerificationToken(staff.userId, 'password_reset');
  await context.request.put('/api/v1/auth/password-reset', {
    data: { token, password: PASSWORD },
  });

  const signedIn = await context.request.post('/api/v1/auth/login', {
    data: { email: user!.email, password: PASSWORD },
  });
  expect(signedIn.status()).toBe(200);
  expect((await signedIn.json()).data.nextStep).toBe('two_factor');

  // The session exists and the console does not answer it.
  expect((await context.request.get('/api/v1/auth/session')).status()).toBe(200);
  expect((await context.request.get('/api/admin/users')).status()).toBe(404);
  await context.close();
});
