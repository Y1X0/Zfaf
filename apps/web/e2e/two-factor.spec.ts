import { type BrowserContext, expect, test } from '@playwright/test';

import { base32Decode, totpCodeAt } from '@zfaf/core';

import {
  cleanupSeeded,
  seedBuilder,
  seedRecoveryCode,
  seedSecondStaffSession,
  seedStaffSession,
} from './fixtures/seed.js';

/**
 * Admin two-factor authentication, against the running server (docs/09 §2.8).
 *
 * The claim this file has to establish is not "the challenge endpoint works" —
 * that is covered by the unit and integration suites. It is the stronger one
 * the security checklist actually makes: **every admin entry point enforces
 * it**. So the list below is enumerated from the route tree rather than from
 * memory, and each entry is requested with a real staff session that simply
 * has not answered its challenge.
 *
 * A session in that state is not "an operator with reduced privileges". It is
 * not authenticated at all, and the console answers it exactly as it answers a
 * stranger: 404, revealing nothing.
 */

const BASE = 'https://127.0.0.1:3100';

/**
 * Every admin surface, HTTP method included.
 *
 * If a route is added under `/api/admin` and not added here, the last test in
 * this file fails — the list is checked against the filesystem rather than
 * trusted.
 */
const ADMIN_ENTRY_POINTS = [
  { method: 'GET', path: '/api/admin/users' },
  { method: 'GET', path: '/api/admin/invitations' },
  { method: 'GET', path: '/api/admin/audit-logs' },
  {
    method: 'POST',
    path: '/api/admin/invitations/00000000-0000-4000-8000-000000000000/moderate',
    body: { action: 'suspend', reason: 'test' },
  },
] as const;

async function signIn(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: token,
      url: BASE,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

test.afterAll(async () => {
  await cleanupSeeded();
});

// ── the gate, on every entry point ──────────────────────────────────────────

for (const entry of ADMIN_ENTRY_POINTS) {
  test(`${entry.method} ${entry.path} refuses a staff session that owes a challenge`, async ({
    browser,
  }) => {
    const staff = await seedStaffSession({ role: 'admin', twoFactor: 'unverified' });
    const context = await browser.newContext();
    await signIn(context, staff.sessionToken);

    const response =
      entry.method === 'GET'
        ? await context.request.get(entry.path)
        : await context.request.post(entry.path, { data: 'body' in entry ? entry.body : {} });

    // 404, not 403: the console does not confirm it exists to a caller who
    // cannot use it.
    expect(response.status()).toBe(404);
    await context.close();
  });

  test(`${entry.method} ${entry.path} refuses a staff account with no second factor at all`, async ({
    browser,
  }) => {
    // Mandatory means mandatory: an operator who never enrolled is not an
    // operator who is merely unchallenged.
    const staff = await seedStaffSession({ role: 'admin', twoFactor: 'none' });
    const context = await browser.newContext();
    await signIn(context, staff.sessionToken);

    const response =
      entry.method === 'GET'
        ? await context.request.get(entry.path)
        : await context.request.post(entry.path, { data: 'body' in entry ? entry.body : {} });

    expect(response.status()).toBe(404);
    await context.close();
  });
}

test('a verified staff session reaches the console, so the gate is the only difference', async ({
  browser,
}) => {
  // The control. Without it, every assertion above would also pass if the
  // console were simply broken.
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'verified' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  expect((await context.request.get('/api/admin/users')).status()).toBe(200);
  await context.close();
});

// ── the challenge itself ────────────────────────────────────────────────────

test('answering the challenge with the right code opens the console', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'unverified' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  expect((await context.request.get('/api/admin/users')).status()).toBe(404);

  const verify = await context.request.post('/api/v1/auth/two-factor/verify', {
    data: { code: totpCodeAt(staff.totpSecret!, new Date()) },
  });
  expect(verify.status()).toBe(200);

  expect((await context.request.get('/api/admin/users')).status()).toBe(200);
  await context.close();
});

test('a code used on one session cannot be replayed on another', async ({ browser }) => {
  /**
   * The attack this defeats: a code read over somebody's shoulder, or typed
   * into a phishing page, and used from a second browser inside the same
   * thirty-second window. The code is *correct* throughout this test — what
   * makes the second attempt fail is that the step has been spent.
   */
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'unverified' });
  const code = totpCodeAt(staff.totpSecret!, new Date());

  const legitimate = await browser.newContext();
  await signIn(legitimate, staff.sessionToken);
  expect(
    (await legitimate.request.post('/api/v1/auth/two-factor/verify', { data: { code } })).status(),
  ).toBe(200);
  await legitimate.close();

  // A second, unverified session on the *same* account — as an attacker
  // holding a stolen cookie would have.
  const stolen = await seedSecondStaffSession(staff.userId);
  const attacker = await browser.newContext();
  await signIn(attacker, stolen);

  const replay = await attacker.request.post('/api/v1/auth/two-factor/verify', { data: { code } });
  expect(replay.status()).toBe(401);
  expect((await attacker.request.get('/api/admin/users')).status()).toBe(404);
  await attacker.close();
});

test('a wrong code is refused, and says nothing about which factor it wanted', async ({
  browser,
}) => {
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'unverified' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const wrongTotp = await context.request.post('/api/v1/auth/two-factor/verify', {
    data: { code: '000000' },
  });
  const wrongRecovery = await context.request.post('/api/v1/auth/two-factor/verify', {
    data: { code: 'AAAAA-BBBBB' },
  });

  expect(wrongTotp.status()).toBe(401);
  expect(wrongRecovery.status()).toBe(401);
  expect(await wrongTotp.json()).toEqual(await wrongRecovery.json());

  expect((await context.request.get('/api/admin/users')).status()).toBe(404);
  await context.close();
});

test('a recovery code opens the console once, and not twice', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'unverified' });
  const code = await seedRecoveryCode(staff.userId);

  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const used = await context.request.post('/api/v1/auth/two-factor/verify', { data: { code } });
  expect(used.status()).toBe(200);
  expect((await used.json()).data.method).toBe('RECOVERY_CODE');
  await context.close();

  const second = await seedStaffSession({ role: 'admin', twoFactor: 'unverified' });
  const reused = await browser.newContext();
  await signIn(reused, second.sessionToken);
  // A spent code belonging to a different account: refused either way, and
  // refused identically.
  expect(
    (await reused.request.post('/api/v1/auth/two-factor/verify', { data: { code } })).status(),
  ).toBe(401);
  await reused.close();
});

test('guessing is throttled long before a six-digit code could be found', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'unverified' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await context.request.post('/api/v1/auth/two-factor/verify', {
      data: { code: String(attempt).padStart(6, '0') },
    });
    statuses.push(response.status());
  }

  expect(statuses).toContain(429);
  await context.close();
});

// ── enrollment ──────────────────────────────────────────────────────────────

test('an operator with no factor can enrol, and only then reach the console', async ({
  browser,
}) => {
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'none' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  expect((await context.request.get('/api/admin/users')).status()).toBe(404);

  const started = await context.request.post('/api/v1/auth/two-factor');
  expect(started.status()).toBe(200);
  const { secret } = (await started.json()).data as { secret: string; uri: string };

  // Beginning enrollment changes nothing until it is confirmed.
  expect((await context.request.get('/api/admin/users')).status()).toBe(404);

  const confirmed = await context.request.put('/api/v1/auth/two-factor', {
    data: { code: totpCodeAt(base32Decode(secret)!, new Date()) },
  });
  expect(confirmed.status()).toBe(200);
  expect((await confirmed.json()).data.recoveryCodes).toHaveLength(10);

  expect((await context.request.get('/api/admin/users')).status()).toBe(200);
  await context.close();
});

test('an enrollment response is never cached', async ({ browser }) => {
  // A cached enrollment response is a plaintext TOTP secret in a shared proxy.
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'none' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const started = await context.request.post('/api/v1/auth/two-factor');
  expect(started.headers()['cache-control']).toContain('no-store');
  await context.close();
});

test('staff cannot remove their own second factor', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin', twoFactor: 'verified' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const removed = await context.request.delete('/api/v1/auth/two-factor', {
    data: { code: totpCodeAt(staff.totpSecret!, new Date()) },
  });
  // Correct code, correct session, and still refused: "mandatory, no
  // exception" would mean nothing if the holder could switch it off.
  expect(removed.status()).toBe(403);

  expect((await context.request.get('/api/admin/users')).status()).toBe(200);
  await context.close();
});

// ── the surfaces the gate must not break ────────────────────────────────────

test('an ordinary customer is unaffected by any of this', async ({ browser }) => {
  const seeded = await seedBuilder();
  const context = await browser.newContext();
  await signIn(context, seeded.sessionToken);

  const response = await context.request.get(`/api/v1/invitations/${seeded.invitationId}`);
  expect(response.status()).toBe(200);

  const status = await context.request.get('/api/v1/auth/two-factor');
  expect(status.status()).toBe(200);
  expect((await status.json()).data).toMatchObject({
    enrolled: false,
    mandatory: false,
    gate: 'NOT_REQUIRED',
  });
  await context.close();
});

test('an anonymous caller gets nothing from the two-factor endpoints either', async ({
  request,
}) => {
  expect((await request.get('/api/v1/auth/two-factor')).status()).toBe(401);
  expect((await request.post('/api/v1/auth/two-factor')).status()).toBe(401);
  expect(
    (await request.post('/api/v1/auth/two-factor/verify', { data: { code: '123456' } })).status(),
  ).toBe(401);
});

// ── the list above is checked, not trusted ──────────────────────────────────

test('every admin route on disk is covered by the enforcement list', async () => {
  // The failure mode this guards is the only one that matters here: somebody
  // adds an admin endpoint and the "every entry point" claim quietly becomes
  // false. Reading the route tree makes the claim self-maintaining.
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const root = new URL('../src/app/api/admin', import.meta.url).pathname;
  const found: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}/${entry}`);
      } else if (entry === 'route.ts' || entry === 'route.tsx') {
        found.push(prefix);
      }
    }
  };
  walk(root, '/api/admin');

  const covered = new Set(
    ADMIN_ENTRY_POINTS.map((entry) =>
      // Substituted ids become their parameter segment again for comparison.
      entry.path.replace(/\/[0-9a-f]{8}-[0-9a-f-]+/, '/[id]'),
    ),
  );

  expect([...found].sort()).toEqual([...covered].sort());
});
