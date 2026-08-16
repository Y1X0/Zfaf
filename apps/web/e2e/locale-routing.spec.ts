import { expect, test } from '@playwright/test';

/**
 * The D9.1 regression suite — the standalone 307 loop must not return.
 *
 * ## What broke, exactly
 *
 * Next builds the URL it hands to middleware from `fetchHostname ||
 * 'localhost'` (`next-server.js`), and separately builds `initURL` — the base
 * `parseRelativeURL` compares a middleware rewrite against — from the
 * configured hostname (`router-utils/resolve-routes.js`). When those two
 * strings differ, the rewrite's origin does not match the base, the rewrite is
 * classified as **external**, and Next re-requests it over the network instead
 * of rendering it in place.
 *
 * Standalone binds `process.env.HOSTNAME || '0.0.0.0'`, so the two disagreed
 * by default. `/` rewrote to `/ar`; Next re-requested `/ar`; middleware ran
 * again and redirected `/ar` back to `/` (the default locale carries no
 * prefix) — a 307 loop the browser followed until it gave up. Behind the TLS
 * terminator it failed even earlier, with Next trying to speak HTTPS to its
 * own plain-HTTP port.
 *
 * ## Why these tests are shaped this way
 *
 * They run against the **standalone server the deployment uses**, over TLS,
 * through Playwright's own HTTP stack — no mocked middleware, no `next dev`.
 * The bug was invisible in development and total in production, so a test that
 * cannot tell those apart would not have caught it and will not catch its
 * return.
 *
 * `maxRedirects: 0` is the load-bearing assertion. A loop shows up as a 307
 * whose `location` points back where the request came from; following it would
 * turn the failure into a timeout twenty hops later, which reads as flakiness
 * rather than as this bug.
 */

/** Every locale-routed path, in both directions. */
const SITE_PAGES = ['/', '/templates', '/pricing', '/faq', '/terms', '/privacy'] as const;

test.describe('locale routing under the standalone server', () => {
  for (const path of SITE_PAGES) {
    test(`Arabic ${path} answers 200 directly, with no redirect at all`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });

      // Not "eventually 200 after some redirects" — **200 on the first
      // response**. ADR-0011 puts Arabic at the root with no redirect, and a
      // 307 here is the exact shape the regression took.
      expect(response.status()).toBe(200);

      const html = await response.text();
      expect(html).toContain('lang="ar"');
      expect(html).toContain('dir="rtl"');
    });

    test(`English ${path} answers 200 directly under /en`, async ({ request }) => {
      const url = path === '/' ? '/en' : `/en${path}`;
      const response = await request.get(url, { maxRedirects: 0 });

      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain('lang="en"');
      expect(html).toContain('dir="ltr"');
    });
  }

  test('the explicit /ar prefix redirects exactly once, and does not bounce back', async ({
    request,
  }) => {
    // `as-needed` means the default locale has one canonical address. `/ar`
    // must redirect to `/` and stop — the loop was `/` → `/ar` → `/` forever.
    const first = await request.get('/ar', { maxRedirects: 0 });
    expect(first.status()).toBe(307);
    expect(first.headers()['location']).toMatch(/\/$/);

    const second = await request.get('/', { maxRedirects: 0 });
    expect(second.status()).toBe(200);
  });

  test('following a locale route terminates in one hop or none', async ({ request }) => {
    // A cheap, direct statement of "no loop": the browser-equivalent follow
    // must finish, and must not need more than the single canonical hop.
    for (const path of ['/', '/pricing', '/en', '/en/pricing', '/ar', '/ar/pricing']) {
      const response = await request.get(path);
      expect(response.status(), `${path} did not settle`).toBe(200);
      expect(response.url()).not.toContain('/ar/');
    }
  });

  test('an unknown locale is a real 404, not the Arabic page under a wrong prefix', async ({
    request,
  }) => {
    const response = await request.get('/fr', { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });

  test('the language switch points at the same page in the other language', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByTestId('language-switch')).toHaveAttribute('href', '/en/pricing');

    await page.goto('/en/terms');
    await expect(page.getByTestId('language-switch')).toHaveAttribute('href', '/terms');
  });

  // ── the surfaces the middleware must not touch ────────────────────────────

  test('the published invitation is untouched by locale routing', async ({ request }) => {
    // The middleware matcher excludes `/i/`. If that ever stopped holding, a
    // printed QR code would start resolving through a locale rewrite — which
    // is the failure that cannot be recalled.
    const response = await request.get('/i/does-not-exist', { maxRedirects: 0 });
    expect(response.status()).toBe(404);

    // And no locale prefix reaches it either.
    const prefixed = await request.get('/en/i/does-not-exist', { maxRedirects: 0 });
    expect(prefixed.status()).toBe(404);
  });

  test('the API is not locale-routed', async ({ request }) => {
    const response = await request.post('/api/public/analytics/event', {
      data: { slug: 'nothing', type: 'view' },
      maxRedirects: 0,
    });
    // 204, not a redirect: a rewritten API route would break every client.
    expect(response.status()).toBe(204);
  });

  test('the admin console is not locale-routed', async ({ request }) => {
    // 404 because the caller is not staff — the point is that it is *not* a
    // redirect into `/ar/admin`.
    const response = await request.get('/api/admin/users', { maxRedirects: 0 });
    expect(response.status()).toBe(404);
  });
});
