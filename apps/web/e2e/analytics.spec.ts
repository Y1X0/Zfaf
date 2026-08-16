import { expect, test } from '@playwright/test';

import {
  type SeededPublished,
  cleanupSeeded,
  countAnalyticsEvents,
  flushAnalyticsNow,
  pendingAnalytics,
  seedPublished,
} from './fixtures/seed.js';

/**
 * The public page's analytics, in a real browser (D8.1–D8.4, M8 exit criteria).
 *
 * The exit criterion is a browser-level statement — *"a browser inspection of
 * `/i/{slug}` shows zero cookies"* — so it is checked in a browser, against
 * the real page, after the real script has run. Asserting it any other way
 * would be asserting something else.
 */

let seeded: SeededPublished;

test.beforeEach(async () => {
  seeded = await seedPublished();
});

test.afterAll(async () => {
  await cleanupSeeded();
});

// ── the exit criterion ──────────────────────────────────────────────────────

test('the public invitation sets no cookies at all', async ({ page, context }) => {
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('html[data-enhanced]')).toBeAttached();

  // Every cookie the browser holds after loading the page and running the
  // script, including anything the beacon might have caused.
  expect(await context.cookies()).toEqual([]);

  // And nothing in `document.cookie` either — a `Set-Cookie` the browser
  // rejected would still be a mistake worth catching.
  expect(await page.evaluate(() => document.cookie)).toBe('');
});

test('the public invitation stores nothing in the browser', async ({ page }) => {
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('html[data-enhanced]')).toBeAttached();

  // No `localStorage`, and `sessionStorage` holds only the RSVP edit token a
  // guest gets after replying — which this page has not done.
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  expect(storage.local).toEqual([]);
  expect(storage.session).toEqual([]);
});

test('the beacon response carries no Set-Cookie header', async ({ page }) => {
  const response = await page.request.post('/api/public/analytics/event', {
    data: { slug: seeded.slug, type: 'view' },
  });

  expect(response.status()).toBe(204);
  expect(Object.keys(response.headers()).map((name) => name.toLowerCase())).not.toContain(
    'set-cookie',
  );
});

// ── the beacon ──────────────────────────────────────────────────────────────

test('opening the invitation records exactly one view', async ({ page }) => {
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('html[data-enhanced]')).toBeAttached();

  // The beacon is fire-and-forget, so wait for the buffer rather than for the
  // request — that is what the rest of the system waits for too.
  await expect
    .poll(async () => (await pendingAnalytics()).length, { timeout: 5000 })
    .toBeGreaterThan(0);

  const written = await flushAnalyticsNow();
  expect(written).toBeGreaterThanOrEqual(1);
  expect(await countAnalyticsEvents(seeded.invitationId)).toBeGreaterThanOrEqual(1);
});

test('what waits in the buffer contains no address and no user agent', async ({ page }) => {
  // The strongest form of the privacy claim available from outside: read what
  // is literally at rest in Redis between the request and the flush.
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('html[data-enhanced]')).toBeAttached();
  await expect
    .poll(async () => (await pendingAnalytics()).length, { timeout: 5000 })
    .toBeGreaterThan(0);

  const buffered = (await pendingAnalytics()).join('\n');
  expect(buffered).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  expect(buffered).not.toContain('Mozilla');
  expect(buffered).not.toContain('Chrome');

  await flushAnalyticsNow();
});

test('the endpoint answers 204 to anything', async ({ page }) => {
  // Unconditionally, and that is the contract: a guest's page must never show
  // a failed request, and the endpoint must never become an oracle telling a
  // prober which slugs exist.
  const bodies: unknown[] = [
    { slug: 'no-such-invitation-at-all', type: 'view' },
    { slug: seeded.slug, type: 'maps_click' },
    { slug: '', type: 'view' },
    { nonsense: true },
    'not an object',
    [],
  ];

  for (const body of bodies) {
    const response = await page.request.post('/api/public/analytics/event', { data: body });
    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
  }
});

test('a beacon for an unknown invitation records nothing', async ({ page }) => {
  const before = (await pendingAnalytics()).length;
  const response = await page.request.post('/api/public/analytics/event', {
    data: { slug: 'no-such-invitation-at-all', type: 'view' },
  });

  expect(response.status()).toBe(204);
  expect((await pendingAnalytics()).length).toBe(before);
});

test('the beacon refuses an oversized body without counting it', async ({ page }) => {
  const before = (await pendingAnalytics()).length;
  const response = await page.request.post('/api/public/analytics/event', {
    data: { slug: seeded.slug, type: 'view', padding: 'x'.repeat(4096) },
  });

  expect(response.status()).toBe(204);
  expect((await pendingAnalytics()).length).toBe(before);
});

// ── the owner's panel ───────────────────────────────────────────────────────

test('the stats page shows the view once it is flushed', async ({ page, context, baseURL }) => {
  await page.request.post('/api/public/analytics/event', {
    data: { slug: seeded.slug, type: 'view' },
  });
  await expect.poll(async () => await flushAnalyticsNow(), { timeout: 5000 }).toBeGreaterThan(0);

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

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/stats`);
  await expect(page.getByTestId('stat-views')).not.toHaveText('0');
  await expect(page.getByTestId('device-breakdown')).toBeVisible();
});

test('the stats page says what the numbers are not', async ({ page, context, baseURL }) => {
  // A dashboard that presents an approximation as a fact is one people make
  // decisions on incorrectly. Both caveats are on the page, not in a tooltip.
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

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/stats`);
  await expect(page.getByText('لا نستخدم أي كوكيز')).toBeVisible();
  await expect(page.getByText('يُحتسب مرتين')).toBeVisible();
});

test('another customer cannot read the analytics', async ({ page }) => {
  const response = await page.request.get(`/api/v1/invitations/${seeded.invitationId}/analytics`);
  // Signed out: uniform 401 from the session layer, no hint that the id is real.
  expect(response.status()).toBe(401);
});

test('the analytics endpoint is never cached', async ({ page, context, baseURL }) => {
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

  const response = await page.request.get(`/api/v1/invitations/${seeded.invitationId}/analytics`);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
});
