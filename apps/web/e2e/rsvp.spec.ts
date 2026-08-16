import { expect, test } from '@playwright/test';

import {
  type SeededPublished,
  cleanupSeeded,
  countRsvps,
  readCounters,
  seedPublished,
} from './fixtures/seed.js';

/**
 * Replying to an invitation, end to end (M7).
 *
 * A guest is the least forgiving user this product has: they did not choose
 * it, they are on whatever phone they own, and they will not try twice. So the
 * first thing checked here is that the form works with **JavaScript switched
 * off** — the enhancement is a convenience, not the mechanism (ADR-0020).
 */

let seeded: SeededPublished;

test.beforeEach(async () => {
  seeded = await seedPublished();
});

test.afterAll(async () => {
  await cleanupSeeded();
});

// ── with no JavaScript at all ───────────────────────────────────────────────

/**
 * These submit with the keyboard rather than by clicking, and the reason is a
 * property of the tool rather than of the page.
 *
 * Playwright's click waits for the element to be *stable*, and that check runs
 * JavaScript inside the page — which is precisely what these tests switch off.
 * The button is asserted visible and enabled first, so the control is still
 * covered; pressing Enter in a text field is native form submission and is how
 * a good share of people send a short form anyway.
 */
test('a guest can reply with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  await page.goto(`/i/${seeded.slug}`);
  await expect(page.getByRole('button', { name: /إرسال/ })).toBeEnabled();

  await page.locator('input[name="partySize"]').fill('3');
  const name = page.getByRole('textbox', { name: /الاسم/ });
  await name.fill('خالد العتيبي');
  await name.press('Enter');

  // The browser posted the form and followed the redirect back; the server
  // rendered the confirmation into the page.
  await expect(page.locator('[data-rsvp-status="ok"]')).toBeVisible();
  expect(await countRsvps(seeded.invitationId)).toBe(1);
  expect(await readCounters(seeded.invitationId)).toEqual({ yes: 1, no: 0, guests: 3 });

  await context.close();
});

test('reloading after a reply does not send it twice', async ({ browser }) => {
  // Post/redirect/get. Without it, a guest pressing refresh out of uncertainty
  // would submit again — and uncertainty is exactly what a slow phone creates.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  await page.goto(`/i/${seeded.slug}`);
  const name = page.getByRole('textbox', { name: /الاسم/ });
  await name.fill('خالد');
  await name.press('Enter');
  await expect(page.locator('[data-rsvp-status="ok"]')).toBeVisible();

  await page.reload();
  expect(await countRsvps(seeded.invitationId)).toBe(1);

  await context.close();
});

test('the confirmation is never cached for the next visitor', async ({ request }) => {
  // `/i/{slug}` is a shared-cache document. A cached "thank you, your reply is
  // recorded" would tell the next guest they had already replied, and hide the
  // form they need.
  const withStatus = await request.get(`/i/${seeded.slug}?rsvp=ok`);
  expect(withStatus.headers()['cache-control']).toBe('private, no-store');

  const plain = await request.get(`/i/${seeded.slug}`);
  expect(plain.headers()['cache-control']).toContain('s-maxage');
});

// ── with the script ─────────────────────────────────────────────────────────

test('a guest replies without leaving the page', async ({ page }) => {
  await page.goto(`/i/${seeded.slug}`);
  await expect(page.locator('html')).toHaveAttribute('data-enhanced', '');

  await page.getByRole('textbox', { name: /الاسم/ }).fill('سارة');
  await page.locator('input[name="partySize"]').fill('2');
  await page.getByRole('button', { name: /إرسال/ }).click();

  await expect(page.locator('[data-rsvp-status="ok"]')).toBeVisible();
  // No navigation: the URL is unchanged, so the guest keeps their place.
  expect(new URL(page.url()).search).toBe('');
  expect(await countRsvps(seeded.invitationId)).toBe(1);
});

test('the counters move exactly once for one guest', async ({ page }) => {
  await page.goto(`/i/${seeded.slug}`);
  await page.getByRole('textbox', { name: /الاسم/ }).fill('خالد');
  await page.locator('input[name="partySize"]').fill('4');
  await page.getByRole('button', { name: /إرسال/ }).click();
  await expect(page.locator('[data-rsvp-status="ok"]')).toBeVisible();

  const counters = await readCounters(seeded.invitationId);
  expect(counters).toEqual({ yes: 1, no: 0, guests: 4 });
});

test('a guest who declines is counted, but not catered for', async ({ page }) => {
  await page.goto(`/i/${seeded.slug}`);
  await page.getByRole('textbox', { name: /الاسم/ }).fill('محمد');
  await page.locator('input[name="attending"][value="no"]').check();
  await page.getByRole('button', { name: /إرسال/ }).click();
  await expect(page.locator('[data-rsvp-status="ok"]')).toBeVisible();

  expect(await readCounters(seeded.invitationId)).toEqual({ yes: 0, no: 1, guests: 0 });
});

// ── abuse and validation ────────────────────────────────────────────────────

test('a party larger than the couple allowed is refused server-side', async ({ request }) => {
  // Bypassing the form entirely, which is what the `max` attribute cannot stop.
  // Nine is a perfectly plausible party; it is *this* invitation that caps at
  // five, and the cap is read from the published snapshot on every submission.
  const response = await request.post(`/api/public/invitations/${seeded.slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data: { name: 'خالد', attending: true, partySize: 9 },
  });

  // 409, not 400: the reply is well formed and it is the invitation's own rule
  // that refuses it. A validation error would send the guest hunting for a typo.
  expect(response.status()).toBe(409);
  expect(await countRsvps(seeded.invitationId)).toBe(0);
});

test('a party size no wedding could have is rejected as malformed', async ({ request }) => {
  // A different guarantee from the one above, and it is worth keeping separate:
  // this never reaches the invitation at all, because no snapshot needs to be
  // loaded to know that 999 people is not a party.
  const response = await request.post(`/api/public/invitations/${seeded.slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data: { name: 'خالد', attending: true, partySize: 999 },
  });

  expect(response.status()).toBe(400);
  expect(await countRsvps(seeded.invitationId)).toBe(0);
});

test('a filled honeypot is answered like a success and writes nothing', async ({ request }) => {
  const response = await request.post(`/api/public/invitations/${seeded.slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data: { name: 'خالد', attending: true, partySize: 1, website: 'http://spam.example' },
  });

  // A bot told it failed simply tries differently.
  expect(response.status()).toBe(200);
  expect(await countRsvps(seeded.invitationId)).toBe(0);
});

test('the rate limit stops a flood from one visitor', async ({ request }) => {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await request.post(`/api/public/invitations/${seeded.slug}/rsvp`, {
      headers: { accept: 'application/json' },
      data: { name: `ضيف ${attempt}`, attending: true, partySize: 1 },
    });
    statuses.push(response.status());
  }

  // Five per ten minutes per visitor (docs/04 §4).
  expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
});

test('a reply to an invitation that is not published is refused', async ({ request }) => {
  const paused = await seedPublished({ status: 'PAUSED' });
  const response = await request.post(`/api/public/invitations/${paused.slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data: { name: 'خالد', attending: true, partySize: 1 },
  });

  // The same 404 the page gives; a different answer would confirm the slug.
  expect(response.status()).toBe(404);
  expect(await countRsvps(paused.invitationId)).toBe(0);
});

test('a name that would run as a formula is stored as typed', async ({ request }) => {
  // Defused at export, not at input: it is the guest's name, and on screen it
  // is only ever text.
  await request.post(`/api/public/invitations/${seeded.slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data: { name: '=cmd|calc', attending: true, partySize: 1 },
  });
  expect(await countRsvps(seeded.invitationId)).toBe(1);
});

// ── correcting a reply ──────────────────────────────────────────────────────

test('a guest can correct their own reply, and only their own', async ({ request }) => {
  const submitted = await request.post(`/api/public/invitations/${seeded.slug}/rsvp`, {
    headers: { accept: 'application/json' },
    data: { name: 'خالد', attending: true, partySize: 2 },
  });
  const body = (await submitted.json()) as { data: { rsvpId: string; editToken: string } };

  const corrected = await request.patch(`/api/public/rsvps/${body.data.rsvpId}`, {
    data: { editToken: body.data.editToken, name: 'خالد', attending: true, partySize: 5 },
  });
  expect(corrected.status()).toBe(200);
  expect((await readCounters(seeded.invitationId)).guests).toBe(5);

  const forged = await request.patch(`/api/public/rsvps/${body.data.rsvpId}`, {
    data: { editToken: 'not-the-token', name: 'خالد', attending: false, partySize: 0 },
  });
  expect(forged.status()).toBe(404);
  // And nothing moved.
  expect((await readCounters(seeded.invitationId)).guests).toBe(5);
});

// ── the form itself ─────────────────────────────────────────────────────────

test('every control on the form is large enough to tap', async ({ page }) => {
  await page.goto(`/i/${seeded.slug}`);

  const undersized = await page.evaluate(() => {
    const form = document.querySelector('[data-rsvp-form]');
    if (!form) return ['no form'];
    return [...form.querySelectorAll('input, textarea, button')]
      .filter((element) => {
        // The honeypot is deliberately hidden from everyone, including this
        // check: it exists to be invisible, and a tap target for a field no
        // person can see would defeat it.
        if (element.closest('[aria-hidden="true"]')) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.height < 40;
      })
      .map((element) => `${element.tagName}[name=${element.getAttribute('name')}]`);
  });

  expect(undersized).toEqual([]);
});

test('the form fits a 390px screen', async ({ page }) => {
  await page.goto(`/i/${seeded.slug}`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
