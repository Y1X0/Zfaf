import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { cleanupSeeded, seedBuilder, seedPublished } from './fixtures/seed.js';

/**
 * Automated accessibility checks (M6 acceptance: Accessibility ≥ 95).
 *
 * Deferred from M3 for want of a real browser, and run here now that one is in
 * the suite. Two limits are worth stating plainly rather than leaving implied:
 *
 *   • **Automated checks find perhaps a third of real barriers.** They catch
 *     contrast, names, roles and structure; they cannot tell whether a
 *     screen-reader announcement makes sense. This is a floor, not a ceiling.
 *   • **The severity filter is deliberate.** Only `serious` and `critical`
 *     violations fail the build. `moderate` findings are real but frequently
 *     stylistic, and a check that fails on everything gets suppressed by
 *     whoever is trying to ship — which is worse than one that fails on what
 *     matters.
 *
 * The public page is checked most carefully: guests did not choose our
 * product, cannot ask us for help, and are opening the link on whatever device
 * they have.
 */

const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.afterAll(async () => {
  await cleanupSeeded();
});

test('the published invitation has no serious accessibility violations', async ({ page }) => {
  const seeded = await seedPublished();
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('.zf-invitation')).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );

  // Named in the failure, because "3 violations" sends the reader to a report
  // they then have to find.
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('the invitation announces itself in the right language and direction', async ({ page }) => {
  // An Arabic invitation marked `lang="en"` is read aloud by a screen reader in
  // an English voice — technically rendering, practically unusable.
  const seeded = await seedPublished();
  await page.goto(`/i/${seeded.slug}`);

  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('the invitation has exactly one first-level heading', async ({ page }) => {
  const seeded = await seedPublished();
  await page.goto(`/i/${seeded.slug}`);

  const headings = await page.locator('h1').count();
  expect(headings).toBe(1);
});

test('the unavailable page is accessible too', async ({ page }) => {
  // The page a guest lands on when a link has expired is the one they are most
  // likely to be confused by, so it is worth the same care.
  await page.goto('/i/no-such-invitation-anywhere');
  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking.map((violation) => violation.id)).toEqual([]);
});

test('the builder has no serious accessibility violations', async ({ page, context, baseURL }) => {
  const seeded = await seedBuilder();
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

  await page.goto(`/builder/${seeded.invitationId}`);
  await expect(page.getByTestId('groom-name')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(STANDARD)
    // The preview is a separate document with its own checks above; axe would
    // otherwise report the same findings twice.
    .exclude('iframe')
    .analyze();

  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});
