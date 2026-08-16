import { type APIRequestContext, expect, test } from '@playwright/test';

import {
  type SeededPublished,
  cleanupSeeded,
  seedBuilder,
  seedPublished,
  seedStaffSession,
} from './fixtures/seed.js';

/**
 * The couple's replies dashboard (D7.5, D7.6).
 *
 * The most sensitive screen in the product: real names and phone numbers of
 * people who never signed up for anything. So alongside "does it show the
 * list", these check the two things that would matter if they were wrong —
 * that another customer sees nothing, and that **platform staff see nothing
 * either**.
 */

let seeded: SeededPublished;

async function reply(
  request: APIRequestContext,
  slug: string,
  data: Record<string, unknown>,
): Promise<void> {
  const response = await request.post(`/api/public/invitations/${slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data,
  });
  expect(response.ok()).toBe(true);
}

test.beforeEach(async ({ context, baseURL }) => {
  seeded = await seedPublished();
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: seeded.sessionToken,
      url: baseURL ?? 'https://127.0.0.1:3100',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
});

test.afterAll(async () => {
  await cleanupSeeded();
});

test('a reply reaches the owner’s dashboard within seconds', async ({ page, request }) => {
  await reply(request, seeded.slug, { name: 'خالد العتيبي', attending: true, partySize: 3 });

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  await expect(page.getByTestId('rsvp-list')).toContainText('خالد العتيبي');
  await expect(page.getByTestId('stat-responses')).toHaveText('1');
  await expect(page.getByTestId('stat-guests')).toHaveText('3');
});

test('filters to those attending and those who declined', async ({ page, request }) => {
  await reply(request, seeded.slug, { name: 'خالد', attending: true, partySize: 2 });
  await reply(request, seeded.slug, { name: 'سارة', attending: false, partySize: 0 });

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  await expect(page.getByTestId('rsvp-row')).toHaveCount(2);

  await page.getByTestId('rsvp-filter-attending').click();
  await expect(page.getByTestId('rsvp-row')).toHaveCount(1);
  await expect(page.getByTestId('rsvp-list')).toContainText('خالد');

  await page.getByTestId('rsvp-filter-declined').click();
  await expect(page.getByTestId('rsvp-list')).toContainText('سارة');
});

test('finds a guest by name', async ({ page, request }) => {
  await reply(request, seeded.slug, { name: 'خالد العتيبي', attending: true, partySize: 1 });
  await reply(request, seeded.slug, { name: 'محمد', attending: true, partySize: 1 });

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  await page.getByTestId('rsvp-search').fill('العتيبي');
  await expect(page.getByTestId('rsvp-row')).toHaveCount(1);
});

test('removing a reply corrects the numbers', async ({ page, request }) => {
  await reply(request, seeded.slug, { name: 'خالد', attending: true, partySize: 4 });

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  await expect(page.getByTestId('stat-guests')).toHaveText('4');

  await page.getByTestId('rsvp-delete').click();
  await expect(page.getByTestId('rsvp-empty')).toBeVisible();
  await expect(page.getByTestId('stat-guests')).toHaveText('0');
});

test('a guest’s name is shown as text, never as markup', async ({ page, request }) => {
  // A guest chooses their own name, and it is the one value on this screen an
  // outsider controls.
  await reply(request, seeded.slug, {
    name: '<img src=x onerror=alert(1)>',
    attending: true,
    partySize: 1,
  });

  const alerts: string[] = [];
  page.on('dialog', (dialog) => {
    alerts.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  await expect(page.getByTestId('rsvp-list')).toContainText('<img src=x onerror=alert(1)>');
  expect(alerts).toEqual([]);
  expect(await page.locator('[data-testid="rsvp-list"] img').count()).toBe(0);
});

// ── the export ──────────────────────────────────────────────────────────────

test('exports a CSV Excel can open in Arabic', async ({ page, request }) => {
  await reply(request, seeded.slug, {
    name: 'خالد العتيبي',
    attending: true,
    partySize: 2,
    phone: '0501234567',
  });

  const response = await page.request.get(
    `/api/v1/invitations/${seeded.invitationId}/rsvps/export`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/csv');
  // Guest data must never sit in a shared cache.
  expect(response.headers()['cache-control']).toContain('no-store');

  const body = await response.body();
  // The UTF-8 byte-order mark. Without it Excel on Windows reads the file in
  // the system code page and the Arabic names open as mojibake.
  expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

  const text = body.toString('utf8');
  expect(text).toContain('خالد العتيبي');
  expect(text).toContain('الاسم');
  expect(text).not.toContain('editToken');
});

test('a name that would run as a formula is defused in the export', async ({ page, request }) => {
  await reply(request, seeded.slug, { name: "=cmd|'/c calc'!A0", attending: true, partySize: 1 });

  const response = await page.request.get(
    `/api/v1/invitations/${seeded.invitationId}/rsvps/export`,
  );
  const text = (await response.body()).toString('utf8');

  // The cell is quoted and prefixed, so Excel reads it as text rather than
  // running it on the couple's laptop.
  expect(text).toContain('"\'=cmd');
  expect(text).not.toMatch(/^=cmd/m);
});

// ── who may look ────────────────────────────────────────────────────────────

test('another customer cannot see the list, the stats or the export', async ({
  browser,
  request,
}) => {
  await reply(request, seeded.slug, { name: 'خالد', attending: true, partySize: 1 });

  const stranger = await seedBuilder();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: stranger.sessionToken,
      url: 'https://127.0.0.1:3100',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  for (const path of ['rsvps', 'rsvps/stats', 'rsvps/export']) {
    const response = await context.request.get(
      `/api/v1/invitations/${seeded.invitationId}/${path}`,
    );
    // 404 rather than 403: a 403 would confirm the invitation exists.
    expect(response.status()).toBe(404);
  }

  await context.close();
});

test('platform staff cannot read guest data either', async ({ browser, request }) => {
  // The acceptance criterion in full. Support can fix a broken link; they have
  // no business knowing who is attending somebody's wedding (docs/09 §3.4).
  await reply(request, seeded.slug, { name: 'خالد', attending: true, partySize: 1 });

  const staff = await seedStaffSession();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: staff.sessionToken,
      url: 'https://127.0.0.1:3100',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  for (const path of ['rsvps', 'rsvps/stats', 'rsvps/export']) {
    const response = await context.request.get(
      `/api/v1/invitations/${seeded.invitationId}/${path}`,
    );
    expect([403, 404]).toContain(response.status());
    expect(await response.text()).not.toContain('خالد');
  }

  const page = await context.newPage();
  const visit = await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  expect(visit?.status()).toBe(404);

  await context.close();
});

test('a signed-out visitor cannot reach the dashboard', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  expect(response?.status()).toBe(404);
  await context.close();
});

// ── the phone ───────────────────────────────────────────────────────────────

test('the dashboard fits a 390px screen and every control is tappable', async ({
  page,
  request,
}) => {
  await reply(request, seeded.slug, { name: 'خالد', attending: true, partySize: 1 });
  await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  await expect(page.getByTestId('rsvp-list')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const undersized = await page.evaluate(() =>
    [...document.querySelectorAll('button, input, select, a')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.height < 40;
      })
      .map((element) => `${element.tagName}.${element.className}`),
  );
  expect(undersized).toEqual([]);
});
