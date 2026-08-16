import { type Page, expect, test } from '@playwright/test';

import { type SeededBuilder, cleanupSeeded, seedBuilder } from './fixtures/seed.js';

/**
 * Publishing from the builder (D6.1, D6.2, D6.5, D6.7, D6.8).
 *
 * The parts that matter most here are not the happy path — that is also
 * covered by the use-case tests — but the two things only a browser can show:
 * that the honesty copy is *actually on screen* wherever an owner is about to
 * share a link, and that edits made a moment earlier are in the published
 * snapshot rather than a second and a half behind it.
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
      secure: true,
      sameSite: 'Lax',
    },
  ]);
});

test.afterAll(async () => {
  await cleanupSeeded();
});

async function openPublishPanel(page: Page): Promise<void> {
  await page.goto(`/builder/${seeded.invitationId}`);
  await expect(page.getByTestId('groom-name')).toBeVisible();
  await page.getByTestId('publish-panel').locator('summary').click();
}

async function fillMinimum(page: Page): Promise<void> {
  await page.goto(`/builder/${seeded.invitationId}`);
  await expect(page.getByTestId('groom-name')).toBeVisible();
  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');
  await page.getByTestId('step-date').click();
  await page.getByTestId('wedding-date').fill('2026-09-20');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'clean', {
    timeout: 15_000,
  });
}

// ── the honesty copy (ADR-0017) ─────────────────────────────────────────────

test('says what "unlisted" really means before the owner confirms', async ({ page }) => {
  await openPublishPanel(page);

  const notice = page.getByTestId('honesty-confirm');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('غير مُدرجة');
  await expect(notice).toContainText('أي شخص يملك الرابط');
});

test('never calls an unlisted invitation private', async ({ page }) => {
  // The failure ADR-0017 exists to prevent is a couple uploading photographs
  // believing "unlisted" means "only my guests". Saying "خاصة" or "سرية", or
  // showing a padlock, would create exactly that belief.
  await openPublishPanel(page);

  const panel = page.getByTestId('publish-panel');
  await expect(panel).not.toContainText('خاصة');
  await expect(panel).not.toContainText('سرية');
  await expect(panel).not.toContainText('🔒');
});

test('repeats it beside the indexing switch', async ({ page }) => {
  await openPublishPanel(page);
  await expect(page.getByTestId('honesty-settings')).toBeVisible();
  await expect(page.getByTestId('visibility-indexed')).not.toBeChecked();
});

// ── publishing ──────────────────────────────────────────────────────────────

test('refuses to publish an unfinished invitation', async ({ page }) => {
  await openPublishPanel(page);
  await expect(page.getByTestId('publish')).toBeDisabled();
  await expect(page.getByTestId('publish-blocked')).toBeVisible();
});

test('publishes, and repeats the notice beside the link', async ({ page }) => {
  await fillMinimum(page);
  await page.getByTestId('publish-panel').locator('summary').click();

  const slug = `e2e-pub-${Date.now().toString(36)}`;
  await page.getByTestId('publish-slug').fill(slug);
  await expect(page.getByTestId('slug-state')).toContainText('متاح');

  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-success')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('published-url')).toContainText(`/i/${slug}`);

  // Placement two of the three ADR-0017 requires: right next to the link the
  // owner is about to send.
  await expect(page.getByTestId('honesty-success')).toBeVisible();
  await expect(page.getByTestId('honesty-success')).toContainText('أي شخص يملك الرابط');
});

test('the published page shows what was typed a moment before', async ({ page, request }) => {
  // Publishing flushes pending edits first. Without that, the snapshot is
  // taken from the version the server had a second and a half ago.
  await fillMinimum(page);
  await page.getByTestId('publish-panel').locator('summary').click();

  const slug = `e2e-fresh-${Date.now().toString(36)}`;
  await page.getByTestId('publish-slug').fill(slug);
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-success')).toBeVisible({ timeout: 20_000 });

  const response = await request.get(`/i/${slug}`);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('أحمد');
});

test('editing after publishing does not change the public page (ADR-0005)', async ({
  page,
  request,
}) => {
  await fillMinimum(page);
  await page.getByTestId('publish-panel').locator('summary').click();

  const slug = `e2e-frozen-${Date.now().toString(36)}`;
  await page.getByTestId('publish-slug').fill(slug);
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-success')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('step-couple').click();
  await page.getByTestId('groom-name').fill('خالد');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'clean', {
    timeout: 15_000,
  });

  // The guest still sees the published version. This is the nightmare ADR-0005
  // was written to prevent: 200 guests watching a half-edited invitation.
  const html = await (await request.get(`/i/${slug}`)).text();
  expect(html).toContain('أحمد');
  expect(html).not.toContain('خالد');
});

// ── the QR code (ADR-0016) ──────────────────────────────────────────────────

test('offers a printable and a shareable QR once published', async ({ page }) => {
  await fillMinimum(page);
  await page.getByTestId('publish-panel').locator('summary').click();
  await page.getByTestId('publish-slug').fill(`e2e-qr-${Date.now().toString(36)}`);
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-success')).toBeVisible({ timeout: 20_000 });

  await expect(page.getByTestId('qr-svg')).toBeVisible();
  await expect(page.getByTestId('qr-png')).toBeVisible();

  // `page.request`, not the standalone `request` fixture: only the page's
  // context carries the session cookie, and this endpoint is owner-scoped.
  const svg = await page.request.get(`/api/v1/invitations/${seeded.invitationId}/qr?format=svg`);
  expect(svg.status()).toBe(200);
  expect(svg.headers()['content-type']).toContain('image/svg+xml');
  // `private`, because it belongs to one owner and no shared cache should hold it.
  expect(svg.headers()['cache-control']).toContain('private');
});

test('will not produce a QR for an invitation that is not published', async ({ page }) => {
  // A printed code pointing at a 404 is unrecoverable — the cards are already
  // in envelopes.
  const response = await page.request.get(
    `/api/v1/invitations/${seeded.invitationId}/qr?format=svg`,
  );
  expect(response.status()).toBe(404);
});

test('will not produce a QR for somebody else’s invitation', async ({ browser }) => {
  const other = await seedBuilder();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: seeded.sessionToken,
      url: 'https://127.0.0.1:3100',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  // 404 rather than 403: answering "forbidden" would confirm the id is real.
  const response = await context.request.get(`/api/v1/invitations/${other.invitationId}/qr`);
  expect(response.status()).toBe(404);
  await context.close();
});

// ── the slug ────────────────────────────────────────────────────────────────

test('refuses a reserved word as an address', async ({ page }) => {
  await openPublishPanel(page);
  await page.getByTestId('publish-slug').fill('admin');
  await expect(page.getByTestId('slug-state')).toContainText('غير متاح');
});

test('suggests an address from the couple’s names', async ({ page }) => {
  await page.goto(`/builder/${seeded.invitationId}`);
  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');
  await page.getByTestId('publish-panel').locator('summary').click();

  // A starting point the owner can edit, not a name chosen for them.
  await expect(page.getByTestId('publish-slug')).toHaveValue(/.+/);
});
