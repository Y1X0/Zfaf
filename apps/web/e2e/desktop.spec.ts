import { expect, test } from '@playwright/test';

import { type SeededBuilder, cleanupSeeded, seedBuilder } from './fixtures/seed.js';

/**
 * The wide layout.
 *
 * Deliberately thin. The phone suite is where the product is proved; this
 * checks only what genuinely differs at width — that both panes are visible at
 * once and the mobile tab strip is gone.
 */

let seeded: SeededBuilder;

test.beforeEach(async ({ context, baseURL }) => {
  seeded = await seedBuilder();
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: seeded.sessionToken,
      url: baseURL ?? 'https://127.0.0.1:3100',
      httpOnly: true,
      // `__Host-` requires Secure and no Domain attribute. Chrome treats
      // 127.0.0.1 as a trustworthy origin, so a Secure cookie is accepted over
      // plain HTTP there and the prefix rules still hold — which means the
      // tests exercise the real cookie, not a relaxed one.
      secure: true,
      sameSite: 'Lax',
    },
  ]);
});

test.afterAll(async () => {
  await cleanupSeeded();
});

test('shows the editor and the preview side by side', async ({ page }) => {
  await page.goto(`/builder/${seeded.invitationId}`);
  await expect(page.getByTestId('groom-name')).toBeVisible();

  // Both panes at once, and no tab strip to switch between them.
  await expect(page.getByTestId('preview-frame')).toBeVisible();
  await expect(page.getByTestId('tab-edit')).not.toBeVisible();

  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('.zf-invitation')).toBeVisible({ timeout: 20_000 });
});

test('edits reach the preview without a tab switch', async ({ page }) => {
  await page.goto(`/builder/${seeded.invitationId}`);
  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');

  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('[data-section="hero"]')).toContainText('أحمد', { timeout: 20_000 });
});
