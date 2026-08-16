import { expect, test } from '@playwright/test';

import { type SeededPublished, cleanupSeeded, retireSlug, seedPublished } from './fixtures/seed.js';

/**
 * The published invitation, end to end (D6.4–D6.10).
 *
 * This is the page a guest actually meets: opened from a WhatsApp message, on
 * a phone, usually on a poor connection. So the suite runs at the acceptance
 * width and asserts on what a guest experiences — that the names are there,
 * that the countdown moves, that nothing is served for an invitation that
 * should not be — rather than on how the page was built.
 */

test.afterAll(async () => {
  await cleanupSeeded();
});

// ── what a guest sees ───────────────────────────────────────────────────────

test.describe('a published invitation', () => {
  let seeded: SeededPublished;

  test.beforeAll(async () => {
    seeded = await seedPublished();
  });

  test('renders the couple through the same renderer as the preview', async ({ page }) => {
    const response = await page.goto(`/i/${seeded.slug}`);
    expect(response?.status()).toBe(200);

    // `zf-invitation` is the renderer's own root class, so this is evidence
    // that published output and builder preview share one renderer (ADR-0004).
    await expect(page.locator('.zf-invitation')).toBeVisible();
    await expect(page.locator('[data-section="hero"]')).toContainText('أحمد');
    await expect(page.locator('[data-section="hero"]')).toContainText('سارة');
  });

  test('ships no framework — only the enhancement script (ADR-0020)', async ({ page }) => {
    await page.goto(`/i/${seeded.slug}`);

    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll('script')].map((s) => s.getAttribute('src') ?? 'inline'),
    );

    // The budget this page is held to is unreachable with a hydrating
    // framework; if a Next chunk ever appears here, the whole premise of
    // ADR-0020 has quietly been abandoned.
    expect(scripts.filter((src) => src?.includes('/_next/'))).toEqual([]);
    expect(scripts).toContain('/invitation.js');
  });

  test('works with JavaScript disabled', async ({ browser }) => {
    // The invitation is a document. Everything but the countdown has to be
    // there before a single byte of script runs.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`/i/${seeded.slug}`);

    await expect(page.locator('[data-section="hero"]')).toContainText('أحمد');
    await expect(page.locator('.zf-invitation')).toBeVisible();
    await context.close();
  });

  test('counts down, corrected against the server clock', async ({ page }) => {
    await page.goto(`/i/${seeded.slug}`);
    await expect(page.locator('html')).toHaveAttribute('data-enhanced', '');

    const days = page.locator('[data-countdown-unit="days"]');
    await expect(days).not.toHaveText('--');

    const seconds = page.locator('[data-countdown-unit="seconds"]');
    const first = await seconds.textContent();
    await expect(seconds).not.toHaveText(first ?? '', { timeout: 4000 });
  });

  test('keeps the countdown right on a phone whose clock is wrong', async ({ browser }) => {
    // The failure this prevents is the most visible one the product could
    // have: an invitation telling a guest the wedding was yesterday.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const skew = 1000 * 60 * 60 * 24 * 400; // a phone set well over a year fast
      const RealDate = Date;
      (globalThis as any).Date = class extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super((RealDate.now() + skew) as any);
          else super(...(args as []));
        }
        static override now(): number {
          return RealDate.now() + skew;
        }
      };
    });

    await page.goto(`/i/${seeded.slug}`);
    await expect(page.locator('html')).toHaveAttribute('data-enhanced', '');

    const units = page.locator('[data-countdown-target]');
    // Uncorrected, this device would put the wedding in the past and the
    // countdown would sit at zero.
    await expect(units).not.toHaveAttribute('data-countdown-elapsed', '');
    await expect(page.locator('[data-countdown-unit="days"]')).not.toHaveText('00');
    await context.close();
  });

  test('carries the link preview a WhatsApp recipient sees', async ({ page }) => {
    await page.goto(`/i/${seeded.slug}`);

    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /أحمد.*سارة/,
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new RegExp(`/i/${seeded.slug}/og$`),
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    );
  });

  test('is noindex by default (ADR-0017)', async ({ page }) => {
    const response = await page.goto(`/i/${seeded.slug}`);
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
  });

  test('serves the strict content security policy', async ({ page }) => {
    const response = await page.goto(`/i/${seeded.slug}`);
    const csp = response?.headers()['content-security-policy'] ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // The two that would make the rest of the policy decorative.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  test('reports no console errors, so the CSP does not block its own script', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`/i/${seeded.slug}`);
    await expect(page.locator('html')).toHaveAttribute('data-enhanced', '');
    expect(errors).toEqual([]);
  });

  test('renders a link-preview card with correctly shaped Arabic', async ({ request }) => {
    const response = await request.get(`/i/${seeded.slug}/og`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');

    const body = await response.body();
    expect([...body.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // A card that failed to find its font would still be a PNG, but a nearly
    // empty one.
    expect(body.byteLength).toBeGreaterThan(4000);
  });

  test('offers sharing only once the script has run', async ({ page }) => {
    await page.goto(`/i/${seeded.slug}`);
    await expect(page.getByTestId('nothing-here')).toHaveCount(0);
    await expect(page.locator('[data-share]')).toBeVisible();
    await expect(page.locator('[data-share]')).toHaveAttribute(
      'data-share-url',
      new RegExp(`/i/${seeded.slug}$`),
    );
  });

  test('fits a 390px screen without sideways scrolling', async ({ page }) => {
    await page.goto(`/i/${seeded.slug}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// ── the security matrix ─────────────────────────────────────────────────────

test.describe('an invitation that must not be served', () => {
  test('a draft answers 404, revealing nothing', async ({ request }) => {
    const seeded = await seedPublished({ status: 'DRAFT' });
    const response = await request.get(`/i/${seeded.slug}`);
    expect(response.status()).toBe(404);
  });

  test('a paused invitation is indistinguishable from a missing one', async ({ request }) => {
    // Pausing is reversible and the owner may be mid-correction, so telling the
    // world it is permanently gone would be a lie we would have to take back.
    const seeded = await seedPublished({ status: 'PAUSED' });
    const response = await request.get(`/i/${seeded.slug}`);
    expect(response.status()).toBe(404);
  });

  test('an expired invitation answers 410', async ({ request }) => {
    const seeded = await seedPublished({ status: 'EXPIRED' });
    const response = await request.get(`/i/${seeded.slug}`);
    expect(response.status()).toBe(410);
  });

  test('an invitation past its expiry answers 410 before the sweep runs', async ({ request }) => {
    // The row still says PUBLISHED. If the route trusted that, the expiry date
    // would mean "some time tomorrow".
    const seeded = await seedPublished({
      status: 'PUBLISHED',
      expiresAt: new Date(Date.now() - 1000),
    });
    const response = await request.get(`/i/${seeded.slug}`);
    expect(response.status()).toBe(410);
  });

  test('a suspended invitation answers 451', async ({ request }) => {
    const seeded = await seedPublished({ status: 'SUSPENDED' });
    const response = await request.get(`/i/${seeded.slug}`);
    expect(response.status()).toBe(451);
  });

  test('none of them are cached or indexed', async ({ request }) => {
    const seeded = await seedPublished({ status: 'SUSPENDED' });
    const response = await request.get(`/i/${seeded.slug}`);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('a slug nobody owns answers 404', async ({ request }) => {
    const response = await request.get('/i/no-such-invitation-anywhere');
    expect(response.status()).toBe(404);
  });

  test('their preview card says nothing about them', async ({ request }) => {
    const seeded = await seedPublished({ status: 'SUSPENDED' });
    const response = await request.get(`/i/${seeded.slug}/og`);
    // Still an image — a broken preview reads as a broken link — but a generic
    // one, and never cached.
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
  });
});

// ── renamed slugs ───────────────────────────────────────────────────────────

test('an old slug redirects permanently to the new one (ADR-0013)', async ({ request }) => {
  // The old link is in hundreds of WhatsApp threads and printed on QR codes
  // that cannot be reissued.
  const seeded = await seedPublished();
  const oldSlug = `e2e-old-${seeded.slug}`;
  await retireSlug(seeded.invitationId, oldSlug);

  const response = await request.get(`/i/${oldSlug}`, { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers()['location']).toContain(`/i/${seeded.slug}`);
});
