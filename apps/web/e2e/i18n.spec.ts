import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

/**
 * The Arabic surface, in a real browser (D9.2, D9.3, D9.6, D9.7).
 *
 * Every marketing and legal page is checked for right-to-left correctness,
 * typography and accessibility, because that is where these bugs live: the
 * `.zf-hero__arch` defect in M6 pushed every Arabic invitation 276px off screen
 * while looking perfect in English.
 *
 * Both languages are exercised, because that is where these bugs live: a
 * right-to-left mistake is invisible in the language the developer was looking
 * at and obvious in the other. Routing itself is covered separately, in
 * `locale-routing.spec.ts`, which guards the D9.1 standalone defect.
 */

/** Every public page, in the order a visitor meets them. */
const PAGES = ['/', '/templates', '/pricing', '/faq', '/terms', '/privacy'] as const;

/**
 * Waits for layout to settle before measuring.
 *
 * The same rule the accessibility suite learned in M7: measuring mid-animation
 * reports a colour and a position that never actually existed on screen.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page
    .evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
    .catch(() => {});
}

/** Horizontal overflow, in pixels. One is tolerated for sub-pixel rounding. */
async function overflow(page: Page): Promise<number> {
  return await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// ── direction and language ──────────────────────────────────────────────────

test('Arabic is served at the root, with no redirect and no prefix', async ({ page }) => {
  // ADR-0011: the majority language is not made to pay a redirect to reach the
  // product, and every URL that existed before this milestone still answers.
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

// ── every page ─────────────────────────────────────────────────────────────

for (const path of PAGES) {
  for (const [locale, url] of [
    ['ar', path],
    ['en', path === '/' ? '/en' : `/en${path}`],
  ] as const) {
    test(`${url} renders in ${locale} with no horizontal overflow`, async ({ page }) => {
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);
      await settled(page);

      // The viewport is 390px. Anything wider than the screen means a fixed
      // width, a physical property, or an unwrapped long word — and on a phone
      // it means the page slides sideways under a thumb.
      expect(await overflow(page)).toBeLessThanOrEqual(1);

      // Nothing untranslated: a missing key renders as its own dotted path.
      const body = (await page.locator('body').innerText()).trim();
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toMatch(/\b[a-z]+\.[a-z]+\.[a-zA-Z]+\b/);
    });

    test(`${url} has no accessibility violations in ${locale}`, async ({ page }) => {
      await page.goto(url);
      await settled(page);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual(
        [],
      );
    });
  }
}

// ── Arabic typography (ADR-0011 §4) ─────────────────────────────────────────

test('Arabic text is never letter-spaced, and never below 16px', async ({ page }) => {
  await page.goto('/');
  await settled(page);

  const offenders = await page.evaluate(() => {
    const problems: string[] = [];
    for (const element of document.querySelectorAll('h1, h2, h3, p, a, button, span, li')) {
      if (!element.textContent?.trim()) continue;
      const style = getComputedStyle(element);

      /**
       * `letter-spacing` on Arabic is not a style choice.
       *
       * Any non-zero value pulls the letters of a word apart and breaks the
       * cursive joins — the word stops being a word. This is the one
       * typographic rule in the ADR written as a prohibition.
       */
      if (style.letterSpacing !== 'normal' && parseFloat(style.letterSpacing) !== 0) {
        problems.push(`${element.tagName}: letter-spacing ${style.letterSpacing}`);
      }

      // 16px is the floor at which the dots separating ب ت ث stay legible at
      // arm's length on a phone.
      if (parseFloat(style.fontSize) < 16 && element.tagName !== 'SPAN') {
        problems.push(`${element.tagName}: font-size ${style.fontSize}`);
      }
    }
    return problems;
  });

  expect(offenders).toEqual([]);
});

test('Arabic line height leaves room for the diacritics', async ({ page }) => {
  await page.goto('/');
  await settled(page);

  const ratio = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
  });

  // 1.9 per ADR-0011 §4: Arabic ascenders, descenders and diacritics all
  // occupy vertical space at once, so the 1.5 a Latin face wants is too tight.
  expect(ratio).toBeGreaterThanOrEqual(1.85);
});

// ── the font (D9.3) ─────────────────────────────────────────────────────────

test('the Arabic font is self-hosted and preloaded', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    // A third-party font host is a request to somebody else's server on every
    // page load, on a product that promises it sets no cookies.
    if (request.resourceType() === 'font' && url.hostname !== '127.0.0.1') {
      external.push(request.url());
    }
  });

  await page.goto('/');
  await settled(page);

  expect(external).toEqual([]);
  await expect(page.locator('link[rel="preload"][as="font"]')).toHaveAttribute(
    'href',
    '/fonts/zfaf-arabic.woff2',
  );
});

// ── error pages (D9.7) ──────────────────────────────────────────────────────

test('a mistyped address gets a translated 404 in each language', async ({ page }) => {
  for (const [url, marker] of [
    ['/no-such-page', 'الصفحة غير موجودة'],
    ['/en/no-such-page', 'Page not found'],
  ] as const) {
    const response = await page.goto(url);
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId('error-not-found')).toContainText(marker);
  }
});

// ── the surfaces that must NOT be localised ─────────────────────────────────

test('the published invitation is not reachable under a locale prefix', async ({ page }) => {
  // An invitation's language belongs to the invitation, not the visitor. Two
  // addresses for one wedding would be an SEO error and an unanswerable
  // question when somebody asks which link to send (ADR-0011 §2).
  const response = await page.goto('/en/i/anything-at-all');
  expect(response?.status()).toBe(404);
});

test('the API is not put behind a locale prefix', async ({ request }) => {
  // A JSON error code is not translated copy, and a `Vary: Accept-Language` on
  // the RSVP endpoint would fragment its cache for nothing.
  const response = await request.post('/api/public/analytics/event', {
    data: { slug: 'nothing', type: 'view' },
  });
  expect(response.status()).toBe(204);
});
