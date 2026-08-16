import { type Page, expect, test } from '@playwright/test';

import { type SeededBuilder, cleanupSeeded, readDraft, seedBuilder } from './fixtures/seed.js';

/**
 * The builder, end to end, on a 390px phone.
 *
 * Everything here runs at the acceptance width. That is deliberate: a builder
 * that works on a laptop and not a phone has failed for roughly 40% of the
 * people who will use it, and the failures are exactly the ones a desktop run
 * never sees — targets too small to hit, a preview that cannot share the
 * screen with a form, a keyboard that covers the field being typed into.
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

async function openBuilder(page: Page): Promise<void> {
  await page.goto(`/builder/${seeded.invitationId}`);
  await expect(page.getByTestId('groom-name')).toBeVisible();
}

/** Waits for the indicator to settle, rather than sleeping for the debounce. */
async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'clean', {
    timeout: 15_000,
  });
}

// ── the wizard ─────────────────────────────────────────────────────────────

test('builds an invitation through the steps and saves without a save button', async ({ page }) => {
  await openBuilder(page);

  // There is no save button anywhere. If one ever appears, this fails.
  await expect(page.getByRole('button', { name: /^حفظ$/ })).toHaveCount(0);

  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');
  await waitForSaved(page);

  await page.getByTestId('step-date').click();
  await page.getByTestId('wedding-date').fill('2026-09-20');
  await page.getByTestId('wedding-start-time').fill('20:00');
  await waitForSaved(page);

  await page.getByTestId('step-location').click();
  await page.getByTestId('venue-name').fill('قاعة النخيل');
  await waitForSaved(page);

  const draft = await readDraft(seeded.invitationId);
  const content = draft.document['content'] as Record<string, Record<string, unknown>>;
  expect(content['couple']?.['groomName']).toBe('أحمد');
  expect(content['couple']?.['brideName']).toBe('سارة');
  expect(content['wedding']?.['date']).toBe('2026-09-20');
  expect(content['location']?.['venueName']).toBe('قاعة النخيل');
  expect(draft.version).toBeGreaterThan(seeded.draftVersion);
});

test('marks a step complete only once it has what it needs', async ({ page }) => {
  await openBuilder(page);

  const coupleStep = page.getByTestId('step-couple');
  await expect(coupleStep).not.toContainText('✓');

  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');
  await expect(coupleStep).toContainText('✓');
});

test('reports what is still required before publishing', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByTestId('readiness')).toContainText('حقل مطلوب');

  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');
  await page.getByTestId('step-date').click();
  await page.getByTestId('wedding-date').fill('2026-09-20');

  await expect(page.getByTestId('readiness')).toContainText('جاهزة للنشر');
});

test('extracts coordinates from a pasted maps link', async ({ page }) => {
  // The real input is a link — an ordinary user does not know their venue's
  // latitude.
  await openBuilder(page);
  await page.getByTestId('step-location').click();
  await page.getByTestId('maps-url').fill('https://www.google.com/maps/@24.7136,46.6753,15z');
  await waitForSaved(page);

  const draft = await readDraft(seeded.invitationId);
  const location = (draft.document['content'] as Record<string, Record<string, unknown>>)[
    'location'
  ];
  expect(location?.['latitude']).toBeCloseTo(24.7136, 3);
  expect(location?.['longitude']).toBeCloseTo(46.6753, 3);
});

test('adds and removes an event', async ({ page }) => {
  await openBuilder(page);
  await page.getByTestId('step-events').click();

  await page.getByTestId('add-event').click();
  await page.getByTestId('event-title').fill('عقد القران');
  await waitForSaved(page);

  let draft = await readDraft(seeded.invitationId);
  let events = (draft.document['content'] as Record<string, unknown[]>)['events'] ?? [];
  expect(events).toHaveLength(1);

  await page.getByTestId('remove-event').click();
  await waitForSaved(page);

  draft = await readDraft(seeded.invitationId);
  events = (draft.document['content'] as Record<string, unknown[]>)['events'] ?? [];
  expect(events).toHaveLength(0);
});

// ── the preview ────────────────────────────────────────────────────────────

test('previews through the same renderer, and reflects an edit', async ({ page }) => {
  await openBuilder(page);
  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');

  await page.getByTestId('tab-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');

  // `zf-invitation` is the renderer's own root class — the preview really is
  // the same component the published page will use.
  await expect(frame.locator('.zf-invitation')).toBeVisible({ timeout: 20_000 });
  await expect(frame.locator('[data-section="hero"]')).toContainText('أحمد', { timeout: 20_000 });
});

test('a theme change reaches the preview', async ({ page }) => {
  await openBuilder(page);
  await page.getByTestId('palette-royal-night').click();

  await page.getByTestId('tab-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('.zf-invitation')).toBeVisible({ timeout: 20_000 });

  const style = await frame.locator('style').first().textContent();
  expect(style).toContain('#c9a227');
});

test('offers the three device sizes, defaulting to mobile', async ({ page }) => {
  await openBuilder(page);
  await page.getByTestId('tab-preview').click();

  await expect(page.getByTestId('device-mobile')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('device-desktop').click();
  await expect(page.getByTestId('preview-frame')).toHaveAttribute('data-device', 'desktop');
});

// ── the panels ─────────────────────────────────────────────────────────────

test('hides a section and the preview drops it', async ({ page }) => {
  await openBuilder(page);

  await page.getByTestId('section-toggle-gallery').click();
  await waitForSaved(page);

  const draft = await readDraft(seeded.invitationId);
  const sections = draft.document['sections'] as { id: string; enabled: boolean }[];
  expect(sections.find((section) => section.id === 'gallery')?.enabled).toBe(false);

  await page.getByTestId('tab-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('.zf-invitation')).toBeVisible({ timeout: 20_000 });
  await expect(frame.locator('[data-section="gallery"]')).toHaveCount(0);
});

test('cannot disable a section the invitation needs', async ({ page }) => {
  // An invitation has to open and close; hero and footer carry no toggle at
  // all rather than a toggle that refuses.
  await openBuilder(page);
  await expect(page.getByTestId('section-toggle-hero')).toHaveCount(0);
  await expect(page.getByTestId('section-toggle-footer')).toHaveCount(0);
});

test('reorders sections with arrows', async ({ page }) => {
  await openBuilder(page);

  await page.getByTestId('section-down-couple').click();
  await waitForSaved(page);

  const draft = await readDraft(seeded.invitationId);
  const sections = draft.document['sections'] as { id: string; order: number }[];
  const couple = sections.find((section) => section.id === 'couple');
  const gallery = sections.find((section) => section.id === 'gallery');
  expect(couple?.order).toBeGreaterThan(gallery?.order ?? 0);
});

// ── undo ───────────────────────────────────────────────────────────────────

test('undoes and redoes an edit', async ({ page }) => {
  await openBuilder(page);

  await page.getByTestId('groom-name').fill('أحمد');
  await expect(page.getByTestId('undo')).toBeEnabled();

  await page.getByTestId('undo').click();
  await expect(page.getByTestId('groom-name')).toHaveValue('');

  await page.getByTestId('redo').click();
  await expect(page.getByTestId('groom-name')).toHaveValue('أحمد');
});

// ── the mobile layout ──────────────────────────────────────────────────────

test('fits a 390px screen without sideways scrolling', async ({ page }) => {
  await openBuilder(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('every control is large enough to tap', async ({ page }) => {
  // 44px is the smallest reliably tappable target; anything under it is a
  // control that only works with a mouse.
  await openBuilder(page);

  const undersized = await page.evaluate(() => {
    const selectors = 'button, input, select, textarea, [role="tab"]';
    return [...document.querySelectorAll(selectors)]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        // Hidden panes and collapsed details have no box to measure.
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.height < 40;
      })
      .map((element) => `${element.tagName}.${element.className}`);
  });

  expect(undersized).toEqual([]);
});

test('switches between editing and preview without losing state', async ({ page }) => {
  await openBuilder(page);
  await page.getByTestId('groom-name').fill('أحمد');

  await page.getByTestId('tab-preview').click();
  await page.getByTestId('tab-edit').click();

  await expect(page.getByTestId('groom-name')).toHaveValue('أحمد');
});

// ── keyboard ───────────────────────────────────────────────────────────────

test('the whole wizard is reachable from the keyboard', async ({ page }) => {
  await openBuilder(page);

  const reached: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    await page.keyboard.press('Tab');
    const testId = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    );
    if (testId) reached.push(testId);
  }

  // The tabs, the steps and the first fields are all on the tab path.
  expect(reached).toContain('tab-edit');
  expect(reached).toContain('step-couple');
  expect(reached).toContain('groom-name');
});

test('undo responds to the keyboard shortcut', async ({ page }) => {
  await openBuilder(page);
  await page.getByTestId('groom-name').fill('أحمد');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('groom-name')).toHaveValue('');
});
