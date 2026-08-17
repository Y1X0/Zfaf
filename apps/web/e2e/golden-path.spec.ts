import { expect, test } from '@playwright/test';

import { cleanupSeeded, readCounters, seedBuilder } from './fixtures/seed.js';

/**
 * The golden path, end to end (D10.1 · PRD §5).
 *
 * Every step below is covered somewhere else in this suite — the builder in
 * `builder.spec.ts`, publishing in `publish.spec.ts`, replying in
 * `rsvp.spec.ts`. What none of those establish is the thing PRD §5 actually
 * claims: that the steps **connect**. A suite of green feature tests is
 * compatible with a product where publishing produces a URL the guest page
 * cannot resolve, and that failure is invisible until somebody walks the whole
 * journey.
 *
 * So this file walks it once, in order, in one browser, on a 390px phone:
 *
 *   fill a draft → preview it → publish it → open the public link as a guest
 *   → reply → see the reply on the owner's dashboard
 *
 * Registration is the one step that is seeded rather than driven: there is no
 * HTTP sign-up route yet (D2.7 landed the session layer, not the endpoints),
 * and a test that pretended otherwise would assert about a path that does not
 * exist. It is named as an open gate in the M10 report rather than skipped
 * quietly.
 *
 * The eight secondary flows PRD §5 implies are listed at the bottom, each
 * pointing at the file that covers it — so "which flows are covered" is a
 * question with a written answer rather than an archaeology exercise.
 */

/**
 * A distinct client address for this suite.
 *
 * The public RSVP endpoint is rate limited per client, in the server's memory,
 * and that limit is real — it is the one thing standing between a published
 * invitation and a script filling its guest list. Two suites submitting
 * replies from the same address share one budget, and the second one to run
 * fails for a reason that has nothing to do with what it is testing.
 *
 * Presenting a different address is not a way around the limit; it is what a
 * different guest genuinely is. `203.0.113.0/24` is the RFC 5737
 * documentation range, so it can never collide with something real.
 */
test.use({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.10' } });

let seeded: Awaited<ReturnType<typeof seedBuilder>>;

test.beforeAll(async () => {
  seeded = await seedBuilder();
});

test.afterAll(async () => {
  await cleanupSeeded();
});

test('a couple fills a draft, publishes it, and a guest replies', async ({ page, request }) => {
  const cookie = { Cookie: `__Host-zfaf_session=${seeded.sessionToken}` };

  // ── 1. the draft ──────────────────────────────────────────────────────────
  // Through the API the builder itself calls, rather than by typing into the
  // wizard: the wizard's own interactions are covered in `builder.spec.ts`,
  // and driving them again here would make this test fail for reasons that
  // have nothing to do with whether the journey connects.
  const patched = await request.patch(`/api/v1/invitations/${seeded.invitationId}/document`, {
    headers: cookie,
    data: {
      baseVersion: seeded.draftVersion,
      patch: [
        { op: 'replace', path: '/content/couple/groomName', value: 'أحمد' },
        { op: 'replace', path: '/content/couple/brideName', value: 'سارة' },
        { op: 'replace', path: '/content/wedding/date', value: '2026-11-20' },
        { op: 'replace', path: '/content/wedding/startTime', value: '20:00' },
        { op: 'replace', path: '/content/location/venueName', value: 'قاعة النخيل' },
      ],
    },
  });
  expect(patched.status(), await patched.text()).toBe(200);

  // ── 2. an honest preview ─────────────────────────────────────────────────
  // ADR-0004's whole premise: the preview and the published page come from one
  // renderer. If they diverged, this is where a couple would first be misled.
  await page.context().addCookies([
    {
      name: '__Host-zfaf_session',
      value: seeded.sessionToken,
      url: 'https://127.0.0.1:3100',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  const preview = await page.goto(`/preview/${seeded.invitationId}`);
  expect(preview?.status()).toBe(200);
  await expect(page.locator('body')).toContainText('أحمد');

  // ── 3. publishing ─────────────────────────────────────────────────────────
  const published = await request.post(`/api/v1/invitations/${seeded.invitationId}/publish`, {
    headers: cookie,
    data: {},
  });
  expect(published.status(), await published.text()).toBe(200);
  const { data } = (await published.json()) as { data: { slug: string } };
  const slug = data.slug;
  expect(slug, 'publishing must hand back the address the couple will send').toBeTruthy();

  // ── 4. the guest ──────────────────────────────────────────────────────────
  // A fresh context: no session cookie, as a guest opening a WhatsApp link.
  const guest = await page.context().browser()!.newContext();
  const guestPage = await guest.newPage();
  const invitation = await guestPage.goto(`/i/${slug}`);

  expect(invitation?.status()).toBe(200);
  await expect(guestPage.locator('.zf-invitation')).toBeVisible();
  await expect(guestPage.locator('body')).toContainText('سارة');

  // The headers M6 established, on the page a guest actually receives.
  const headers = invitation!.headers();
  expect(headers['cache-control']).toContain('s-maxage=300');
  expect(headers['x-robots-tag']).toContain('noindex');

  // ── 5. the reply ──────────────────────────────────────────────────────────
  const before = await readCounters(seeded.invitationId);
  const reply = await guest.request.post(`/api/public/invitations/${slug}/rsvp`, {
    data: { attending: true, name: 'خالد', partySize: 2 },
  });
  expect(reply.status(), await reply.text()).toBe(201);
  await guest.close();

  // ── 6. the number the couple came for ────────────────────────────────────
  // "How many are coming" is the question the product exists to answer
  // (PRD §1.1), so the journey is not finished until the owner can see it.
  const stats = await request.get(`/api/v1/invitations/${seeded.invitationId}/rsvps/stats`, {
    headers: cookie,
  });
  expect(stats.status()).toBe(200);
  const counts = (await stats.json()) as { data: Record<string, number> };
  const after = await readCounters(seeded.invitationId);
  expect(after.yes).toBe(before.yes + 1);
  expect(after.guests).toBe(before.guests + 2);
  // And the number the owner is shown agrees with the number in the database.
  expect(Object.values(counts.data)).toContain(after.yes);
});

/**
 * The eight secondary flows, and where each is proven.
 *
 * This test asserts nothing about the application. It asserts that the files
 * claiming to cover these flows exist and contain a test for them — so the
 * coverage claim in the M10 report is checked rather than asserted, and a file
 * deleted in a future refactor takes this with it.
 */
test('every secondary flow named in the milestone has a suite that covers it', async () => {
  const { readFileSync, existsSync } = await import('node:fs');

  const FLOWS: readonly { flow: string; spec: string; marker: RegExp }[] = [
    {
      flow: 'edit after publishing, and republish',
      spec: 'publish.spec.ts',
      marker: /republish|إعادة النشر|version/i,
    },
    {
      // Covered on the guest's side rather than the owner's: what matters is
      // that a paused invitation stops being served, and says "not found"
      // rather than "gone" — pausing is reversible and the owner may be
      // mid-correction.
      flow: 'a paused invitation stops being served',
      spec: 'public-page.spec.ts',
      marker: /PAUSED/,
    },
    {
      flow: 'a guest replies with JavaScript disabled',
      spec: 'rsvp.spec.ts',
      marker: /JavaScript disabled/i,
    },
    {
      flow: 'a guest edits their own reply',
      spec: 'rsvp.spec.ts',
      marker: /edit|token/i,
    },
    {
      flow: 'the owner exports replies as CSV',
      spec: 'rsvp-dashboard.spec.ts',
      marker: /csv|export/i,
    },
    {
      flow: 'an operator suspends an abusive invitation',
      spec: 'admin.spec.ts',
      marker: /suspend/i,
    },
    {
      flow: 'a stale autosave is rejected rather than silently rebased',
      spec: 'recovery.spec.ts',
      marker: /baseVersion|conflict|409/i,
    },
    {
      flow: 'switching between Arabic and English on every page',
      spec: 'i18n.spec.ts',
      marker: /renders in en|language/i,
    },
  ];

  const missing: string[] = [];
  for (const entry of FLOWS) {
    const path = new URL(`./${entry.spec}`, import.meta.url).pathname;
    if (!existsSync(path)) {
      missing.push(`${entry.flow}: ${entry.spec} does not exist`);
      continue;
    }
    if (!entry.marker.test(readFileSync(path, 'utf8'))) {
      missing.push(`${entry.flow}: ${entry.spec} no longer contains a matching test`);
    }
  }

  expect(missing).toEqual([]);
});
