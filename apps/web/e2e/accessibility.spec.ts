import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

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

/**
 * Waits for the entry animations to finish before measuring.
 *
 * Contrast is a property of the *rendered* page. Sections fade in over 450ms,
 * and a colour sampled at 60% opacity is not the colour anyone reads — the
 * submit button measures 3.49:1 mid-fade and 4.90:1 once it has arrived.
 * Sampling early would fail a page that is compliant, and the usual response
 * to that is to loosen the threshold, which is the wrong repair.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState === 'finished'),
  );
}

test.afterAll(async () => {
  await cleanupSeeded();
});

test('the published invitation has no serious accessibility violations', async ({ page }) => {
  const seeded = await seedPublished();
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('.zf-invitation')).toBeVisible();
  await settled(page);

  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );

  // Named in the failure, because "3 violations" sends the reader to a report
  // they then have to find.
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('a customised palette still passes contrast on every control', async ({ page }) => {
  /**
   * The palette below is one a real owner chose, and it is the one Lighthouse
   * caught in M9: `#b8860b` on ivory rendered the share button in near-white on
   * gold at 3.2:1, against a 4.5:1 requirement.
   *
   * The default fixture palette clears the bar comfortably, which is exactly
   * why the suite could not see this — every shipped template is fine, and the
   * failure only exists once somebody picks her own colours. So this test
   * deliberately seeds the palette that failed rather than a safe one.
   */
  const seeded = await seedPublished({ themeColors: { primary: '#b8860b' } });
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('.zf-invitation')).toBeVisible();
  // The share control is rendered `hidden` and revealed by the script, and axe
  // skips hidden elements — so waiting for it is what makes this test real.
  await expect(page.locator('.zf-share')).toBeVisible();
  await settled(page);

  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');

  expect(
    contrast.flatMap((violation) => violation.nodes.map((node) => node.failureSummary)),
  ).toEqual([]);
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
  await settled(page);
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
  await settled(page);

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

test('the RSVP form is reachable and labelled', async ({ page }) => {
  // A guest replying with a screen reader gets the same form everyone else
  // does, so every control needs a name and the outcome needs announcing.
  const seeded = await seedPublished();
  await page.goto(`/i/${seeded.slug}`);
  await settled(page);

  await expect(page.getByRole('textbox', { name: /الاسم/ })).toBeVisible();
  await expect(page.getByRole('group', { name: /هل ستحضر/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /إرسال/ })).toBeEnabled();
  // The live region is present before it has anything to say: one added at the
  // same moment its content arrives is frequently never announced.
  await expect(page.locator('[data-rsvp-status][aria-live="polite"]')).toHaveCount(1);
});

test('the replies dashboard has no serious accessibility violations', async ({
  page,
  context,
  baseURL,
}) => {
  const seeded = await seedPublished();
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

  await page.goto(`/dashboard/invitations/${seeded.invitationId}/rsvps`);
  await expect(page.getByTestId('rsvp-stats')).toBeVisible();
  await settled(page);

  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

/**
 * The pages a customer meets first (docs/23 §7).
 *
 * Checked as a group rather than one test each: they share a frame and a
 * stylesheet, so a contrast or label failure would be the same failure four
 * times, and naming the page in the assertion message is enough to find it.
 *
 * These matter for the same reason the public page does. Somebody who cannot
 * use the sign-in form cannot reach any of the accessible pages behind it —
 * an inaccessible front door makes the whole product inaccessible, however
 * careful everything past it is.
 */
test.describe('the auth pages', () => {
  const PAGES = [
    { path: '/register', ready: 'register-form' },
    { path: '/login', ready: 'login-form' },
    { path: '/forgot-password', ready: 'forgot-form' },
    // With a token, so the form renders rather than the "link expired" notice.
    { path: '/reset-password?token=not-a-real-token', ready: 'reset-form' },
  ] as const;

  for (const surface of PAGES) {
    test(`${surface.path} has no serious accessibility violations`, async ({ page }) => {
      await page.goto(surface.path);
      await expect(page.getByTestId(surface.ready)).toBeVisible();
      await settled(page);

      const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
      const blocking = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(
        blocking.map((violation) => `${violation.id}: ${violation.help}`),
        `on ${surface.path}`,
      ).toEqual([]);
    });
  }
});

test('the dashboard has no serious accessibility violations', async ({
  page,
  context,
  baseURL,
}) => {
  const seeded = await seedPublished();
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

  await page.goto('/dashboard');
  await expect(page.getByTestId('invitation-list')).toBeVisible();
  // The create form is opened, because a collapsed form is not a form anyone
  // has to be able to use — and the fields inside it are.
  await page.getByTestId('new-invitation').click();
  await expect(page.getByTestId('new-invitation-form')).toBeVisible();
  await settled(page);

  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});
