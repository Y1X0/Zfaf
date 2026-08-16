import { type BrowserContext, expect, test } from '@playwright/test';

import {
  type SeededPublished,
  cleanupSeeded,
  seedBuilder,
  seedPublished,
  seedStaffSession,
} from './fixtures/seed.js';

/**
 * The admin console and the kill switch, end to end (D8.5–D8.7).
 *
 * The exit criterion here is a timing claim — *"suspending an invitation takes
 * effect within ten seconds of the button being pressed"* — so it is measured
 * against a running server: press, then fetch the public page and read the
 * status code. Everything else in this file is about who may press it.
 */

let seeded: SeededPublished;

const BASE = 'https://127.0.0.1:3100';

async function signIn(context: BrowserContext, token: string, baseURL?: string): Promise<void> {
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: token,
      url: baseURL ?? BASE,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

test.beforeEach(async () => {
  seeded = await seedPublished();
});

test.afterAll(async () => {
  await cleanupSeeded();
});

// ── the exit criterion ──────────────────────────────────────────────────────

test('suspending an invitation takes it off the public page within seconds', async ({
  browser,
  request,
}) => {
  // Before: the invitation renders.
  expect((await request.get(`/i/${seeded.slug}`)).status()).toBe(200);

  const staff = await seedStaffSession({ role: 'support' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const pressed = Date.now();
  const moderation = await context.request.post(
    `/api/admin/invitations/${seeded.invitationId}/moderate`,
    { data: { action: 'suspend', reason: 'impersonation report' } },
  );
  expect(moderation.status()).toBe(200);

  const after = await request.get(`/i/${seeded.slug}`);
  const elapsed = Date.now() - pressed;

  // 451, not 404: saying "never existed" would hide an action we are
  // accountable for, and saying "gone" would be a lie.
  expect(after.status()).toBe(451);
  expect(elapsed).toBeLessThan(10_000);

  await context.close();
});

test('the suspended page is never cached, so an edge cannot keep serving it', async ({
  browser,
  request,
}) => {
  const staff = await seedStaffSession({ role: 'support' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);
  await context.request.post(`/api/admin/invitations/${seeded.invitationId}/moderate`, {
    data: { action: 'suspend', reason: 'reported' },
  });

  const response = await request.get(`/i/${seeded.slug}`);
  expect(response.status()).toBe(451);
  expect(response.headers()['cache-control']).toContain('no-store');

  await context.close();
});

test('unsuspending returns the invitation to a paused state, not to published', async ({
  browser,
  request,
}) => {
  const staff = await seedStaffSession({ role: 'support' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  await context.request.post(`/api/admin/invitations/${seeded.invitationId}/moderate`, {
    data: { action: 'suspend', reason: 'reported' },
  });
  const lifted = await context.request.post(
    `/api/admin/invitations/${seeded.invitationId}/moderate`,
    { data: { action: 'unsuspend', reason: 'report withdrawn' } },
  );

  expect(lifted.status()).toBe(200);
  expect((await lifted.json()).data.status).toBe('PAUSED');

  // Moderation lifting a block does not decide the invitation should be live
  // again — the owner does, by publishing. So the page is 404, not 200.
  expect((await request.get(`/i/${seeded.slug}`)).status()).toBe(404);

  await context.close();
});

test('the response reports honestly that no CDN purge happened', async ({ browser }) => {
  // No zone is configured in this environment. Claiming a purge anyway would
  // leave an operator believing a page was pulled from the edge when it was
  // not — the response says `purged: false` and gives the reason.
  const staff = await seedStaffSession({ role: 'support' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const response = await context.request.post(
    `/api/admin/invitations/${seeded.invitationId}/moderate`,
    { data: { action: 'suspend', reason: 'reported' } },
  );

  const body = await response.json();
  expect(body.data.purged).toBe(false);
  expect(body.data.purgeError).toBeTruthy();

  await context.close();
});

test('a suspension with no reason is refused', async ({ browser, request }) => {
  const staff = await seedStaffSession({ role: 'support' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const response = await context.request.post(
    `/api/admin/invitations/${seeded.invitationId}/moderate`,
    { data: { action: 'suspend', reason: '   ' } },
  );

  expect(response.status()).toBe(400);
  // And the invitation is untouched.
  expect((await request.get(`/i/${seeded.slug}`)).status()).toBe(200);

  await context.close();
});

// ── who may press it ────────────────────────────────────────────────────────

test('a customer cannot reach the admin API or the kill switch', async ({ browser, request }) => {
  const customer = await seedBuilder();
  const context = await browser.newContext();
  await signIn(context, customer.sessionToken);

  for (const path of ['/api/admin/users', '/api/admin/invitations', '/api/admin/audit-logs']) {
    const response = await context.request.get(path);
    // 404, not 403: a 403 would confirm that an admin console lives here.
    expect(response.status()).toBe(404);
  }

  const moderation = await context.request.post(
    `/api/admin/invitations/${seeded.invitationId}/moderate`,
    { data: { action: 'suspend', reason: 'let me try' } },
  );
  expect(moderation.status()).toBe(404);
  expect((await request.get(`/i/${seeded.slug}`)).status()).toBe(200);

  await context.close();
});

test('an owner cannot lift a block on their own invitation', async ({ browser, request }) => {
  const staff = await seedStaffSession({ role: 'support' });
  const staffContext = await browser.newContext();
  await signIn(staffContext, staff.sessionToken);
  await staffContext.request.post(`/api/admin/invitations/${seeded.invitationId}/moderate`, {
    data: { action: 'suspend', reason: 'reported' },
  });
  await staffContext.close();

  const owner = await browser.newContext();
  await signIn(owner, seeded.sessionToken);
  const attempt = await owner.request.post(
    `/api/admin/invitations/${seeded.invitationId}/moderate`,
    { data: { action: 'unsuspend', reason: 'it is mine' } },
  );

  expect(attempt.status()).toBe(404);
  expect((await request.get(`/i/${seeded.slug}`)).status()).toBe(451);

  await owner.close();
});

test('a signed-out visitor cannot reach the admin pages', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  for (const path of ['/admin/users', '/admin/invitations', '/admin/audit']) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
  }

  await context.close();
});

test('an operator whose session is older than four hours is refused', async ({ browser }) => {
  // A support laptop left open for a week holds a valid session — valid, but
  // no longer evidence that the person at the keyboard is the one who signed
  // in (docs/04 §10).
  const stale = await seedStaffSession({ role: 'admin', signedInMinutesAgo: 5 * 60 });
  const context = await browser.newContext();
  await signIn(context, stale.sessionToken);

  expect((await context.request.get('/api/admin/users')).status()).toBe(404);

  await context.close();
});

test('support may browse but may not read the audit log', async ({ browser }) => {
  const support = await seedStaffSession({ role: 'support' });
  const context = await browser.newContext();
  await signIn(context, support.sessionToken);

  expect((await context.request.get('/api/admin/users')).status()).toBe(200);
  expect((await context.request.get('/api/admin/invitations')).status()).toBe(200);
  // Where an operator's own actions are recorded is `admin` and above.
  expect((await context.request.get('/api/admin/audit-logs')).status()).toBe(404);

  await context.close();
});

// ── what the console shows ──────────────────────────────────────────────────

test('the invitation list shows a reply count and never a reply', async ({ browser, request }) => {
  await request.post(`/api/public/invitations/${seeded.slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data: { name: 'خالد العتيبي', attending: true, partySize: 2, phone: '0501234567' },
  });

  const staff = await seedStaffSession({ role: 'admin' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const response = await context.request.get(
    `/api/admin/invitations?q=${encodeURIComponent(seeded.slug)}`,
  );
  expect(response.status()).toBe(200);

  const text = await response.text();
  expect(text).toContain('"rsvpCount":1');
  // The whole point of the console's shape: staff see that replies exist and
  // never who sent them (docs/09 §3.4).
  expect(text).not.toContain('خالد');
  expect(text).not.toContain('0501234567');

  await context.close();
});

test('the admin console is not cacheable and not framable', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const response = await context.request.get('/api/admin/users');
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers()['x-frame-options']).toBe('DENY');

  await context.close();
});

test('every admin action and every admin read is written to the audit log', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  await context.request.get('/api/admin/users?q=someone');
  await context.request.post(`/api/admin/invitations/${seeded.invitationId}/moderate`, {
    data: { action: 'suspend', reason: 'reported content' },
  });

  const audit = await context.request.get('/api/admin/audit-logs');
  expect(audit.status()).toBe(200);
  const actions = (await audit.json()).data.rows.map((row: { action: string }) => row.action);

  expect(actions).toContain('admin.users.list');
  expect(actions).toContain('invitation.suspend');

  /**
   * Reading the log is recorded too — on the way out, so the *second* read is
   * where it appears.
   *
   * The ordering is deliberate: the entry is written after the rows are
   * fetched, so a read never contains itself. An audit trail with a hole
   * shaped like "people looking at the audit trail" is the one hole worth
   * least having, and this is what proves there is none.
   */
  const second = await context.request.get('/api/admin/audit-logs?action=admin.audit.list');
  expect((await second.json()).data.total).toBeGreaterThan(0);

  await context.close();
});

test('the audit viewer renders the entries', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  await context.request.post(`/api/admin/invitations/${seeded.invitationId}/moderate`, {
    data: { action: 'suspend', reason: 'reported content' },
  });

  const page = await context.newPage();
  await page.goto('/admin/audit');
  await expect(page.getByTestId('admin-audit')).toBeVisible();
  await expect(page.getByTestId('admin-audit')).toContainText('invitation.suspend');

  await context.close();
});

test('the invitation console finds an invitation by slug', async ({ browser }) => {
  const staff = await seedStaffSession({ role: 'admin' });
  const context = await browser.newContext();
  await signIn(context, staff.sessionToken);

  const page = await context.newPage();
  await page.goto(`/admin/invitations?q=${encodeURIComponent(seeded.slug)}`);
  await expect(page.getByTestId('admin-invitations')).toContainText(seeded.slug);

  await context.close();
});
