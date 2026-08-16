import { type BrowserContext, type Page, expect, test } from '@playwright/test';

import { type SeededBuilder, cleanupSeeded, readDraft, seedBuilder } from './fixtures/seed.js';

/**
 * Losing the connection, and losing the tab (D5.6, D5.7, Exit Criteria).
 *
 * This is the milestone's exit criterion and the reason the builder has no
 * save button: the promise is that work is never lost, and a promise like that
 * has to be demonstrated rather than asserted.
 *
 * The scenario is the real one, not a contrived version. On iOS, opening the
 * photo picker frequently causes Safari to discard the page; the user comes
 * back to a reloaded tab. If anything typed before that moment is gone, they
 * find out at the worst possible time.
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

async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'clean', {
    timeout: 15_000,
  });
}

/** Cuts the connection at the browser, the way a tunnel or a lift does. */
async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}

async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false);
}

// ── the exit criterion ─────────────────────────────────────────────────────

test('an edit survives losing the connection and closing the tab', async ({ context }) => {
  const page = await context.newPage();
  await openBuilder(page);

  await page.getByTestId('groom-name').fill('أحمد');
  await waitForSaved(page);

  // The connection drops mid-sentence.
  await goOffline(context);
  await page.getByTestId('bride-name').fill('سارة');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'offline', {
    timeout: 15_000,
  });

  // …and the tab goes away before it comes back. Nothing has reached the
  // server for the second name at this point.
  await page.close();

  const beforeReturn = await readDraft(seeded.invitationId);
  const savedContent = beforeReturn.document['content'] as Record<string, Record<string, unknown>>;
  expect(savedContent['couple']?.['groomName']).toBe('أحمد');
  expect(savedContent['couple']?.['brideName']).toBe('');

  // The user comes back, connection restored.
  await goOnline(context);
  const returned = await context.newPage();
  await openBuilder(returned);

  // Restored from IndexedDB without being asked: the local draft was built on
  // the version the server still reports, so replaying it loses nothing.
  await expect(returned.getByTestId('bride-name')).toHaveValue('سارة', { timeout: 20_000 });
  await waitForSaved(returned);

  const afterReturn = await readDraft(seeded.invitationId);
  const finalContent = afterReturn.document['content'] as Record<string, Record<string, unknown>>;
  expect(finalContent['couple']?.['groomName']).toBe('أحمد');
  expect(finalContent['couple']?.['brideName']).toBe('سارة');
});

test('a reload mid-edit loses nothing', async ({ page }) => {
  await openBuilder(page);

  await page.getByTestId('groom-name').fill('أحمد');
  await page.getByTestId('bride-name').fill('سارة');
  await waitForSaved(page);

  await page.reload();
  await expect(page.getByTestId('groom-name')).toHaveValue('أحمد');
  await expect(page.getByTestId('bride-name')).toHaveValue('سارة');
});

test('typing while offline keeps retrying rather than giving up', async ({ context }) => {
  // The defect this guards against was real: one timer slot meant every
  // keystroke pushed the reconnect attempt back, so the person still typing
  // never retried at all.
  const page = await context.newPage();
  await openBuilder(page);

  await goOffline(context);
  for (const value of ['أ', 'أح', 'أحم', 'أحمد']) {
    await page.getByTestId('groom-name').fill(value);
    await page.waitForTimeout(400);
  }

  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'offline', {
    timeout: 15_000,
  });

  await goOnline(context);
  await waitForSaved(page);

  const draft = await readDraft(seeded.invitationId);
  const content = draft.document['content'] as Record<string, Record<string, unknown>>;
  expect(content['couple']?.['groomName']).toBe('أحمد');
  await page.close();
});

test('the indicator never claims saved while work is queued', async ({ context }) => {
  // The status is the only signal a user has that their work is safe. Saying
  // "saved" while bytes are still queued is worse than saying nothing.
  const page = await context.newPage();
  await openBuilder(page);

  await goOffline(context);
  await page.getByTestId('groom-name').fill('أحمد');

  await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-status', 'clean', {
    timeout: 10_000,
  });

  await goOnline(context);
  await waitForSaved(page);
  await page.close();
});

// ── conflicts ──────────────────────────────────────────────────────────────

test('two tabs editing different fields merge without asking', async ({ context }) => {
  // The overwhelmingly common case: one person, phone and laptop. Interrupting
  // them with a dialog here would be noise.
  const first = await context.newPage();
  const second = await context.newPage();

  await openBuilder(first);
  await openBuilder(second);

  await first.getByTestId('groom-name').fill('أحمد');
  await waitForSaved(first);

  // The second tab still believes it is on the earlier version.
  await second.getByTestId('bride-name').fill('سارة');
  await waitForSaved(second);

  await expect(second.getByTestId('conflict-prompt')).toHaveCount(0);

  const draft = await readDraft(seeded.invitationId);
  const content = draft.document['content'] as Record<string, Record<string, unknown>>;
  expect(content['couple']?.['groomName']).toBe('أحمد');
  expect(content['couple']?.['brideName']).toBe('سارة');

  await first.close();
  await second.close();
});

test('two tabs editing the same field ask, and keep the chosen edit', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();

  await openBuilder(first);
  await openBuilder(second);

  await first.getByTestId('groom-name').fill('محمد');
  await waitForSaved(first);

  await second.getByTestId('groom-name').fill('أحمد');

  const prompt = second.getByTestId('conflict-prompt');
  await expect(prompt).toBeVisible({ timeout: 20_000 });

  await second.getByTestId('conflict-keep-mine').click();
  await waitForSaved(second);

  const draft = await readDraft(seeded.invitationId);
  const content = draft.document['content'] as Record<string, Record<string, unknown>>;
  expect(content['couple']?.['groomName']).toBe('أحمد');

  await first.close();
  await second.close();
});

// ── the security invariant, from the outside ───────────────────────────────

test('the autosave endpoint refuses a patch that reaches for authority', async ({ request }) => {
  // The same invariant the unit and integration suites cover, asserted here
  // over real HTTP — the layer a client actually talks to.
  const response = await request.patch(`/api/v1/invitations/${seeded.invitationId}/document`, {
    headers: { Cookie: `__Host-zfaf_session=${seeded.sessionToken}` },
    data: {
      baseVersion: seeded.draftVersion,
      patch: [{ op: 'replace', path: '/status', value: 'PUBLISHED' }],
    },
  });

  expect(response.status()).toBe(400);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe('PATCH_REJECTED');

  const draft = await readDraft(seeded.invitationId);
  expect(draft.version).toBe(seeded.draftVersion);
});

test('another account cannot open this builder', async ({ browser }) => {
  const other = await seedBuilder();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: other.sessionToken,
      url: 'https://127.0.0.1:3100',
      httpOnly: true,
      // `__Host-` requires Secure and no Domain attribute. Chrome treats
      // 127.0.0.1 as a trustworthy origin, so a Secure cookie is accepted over
      // plain HTTP there and the prefix rules still hold — which means the
      // tests exercise the real cookie, not a relaxed one.
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  const page = await context.newPage();
  const response = await page.goto(`/builder/${seeded.invitationId}`);
  expect(response?.status()).toBe(404);

  await context.close();
});

test('a signed-out visitor cannot open the builder', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(`/builder/${seeded.invitationId}`);
  expect(response?.status()).toBe(404);
  await context.close();
});
