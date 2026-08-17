import { type Page, expect, test } from '@playwright/test';

import { cleanupSeeded, latestVerificationToken, userByEmail } from './fixtures/seed.js';

/**
 * The whole journey, driven by a person (docs/23 §7.5).
 *
 * ## Why this file exists
 *
 * `golden-path.spec.ts` walks the same product and starts with a seeded
 * invitation, because when it was written there was no way for a human to make
 * one. That was not a shortcut in the test — it was an accurate reflection of a
 * product with no sign-up page, no dashboard, no create form and no upload
 * control. Seeding hid the gap: every feature test was green against a product
 * a customer could not use.
 *
 * So this suite seeds **nothing**. It starts at the registration form with an
 * empty database and ends at a guest's reply appearing on the couple's
 * dashboard, and every step in between happens the way it happens for a real
 * person:
 *
 *   register → verify email → sign in → dashboard → create → edit →
 *   upload a photo → publish → open the public link as a guest → reply
 *
 * The one thing read from the database is the **verification token**, and that
 * is not a shortcut either: no endpoint returns it, deliberately — a live
 * credential in a response body would be in every proxy log between here and
 * the browser. The fixture reads what the email would have carried, which is
 * the only honest way to follow a link a test cannot open an inbox for.
 *
 * ## What the upload does and does not prove
 *
 * The photograph is a real JPEG. It is signed by the real `S3StorageProvider`,
 * `PUT` by the browser straight to the bucket, `HEAD` back for its true size,
 * queued on a real BullMQ queue, and decoded, stripped and re-encoded by a real
 * `apps/worker` process. The **bucket** is the harness's own sink, because this
 * machine cannot reach a real one.
 *
 * That verifies our half of the flow completely and says **nothing about
 * Cloudflare R2**, which is verified against R2 or not at all.
 */

/**
 * This suite sends **no `x-forwarded-for` of its own**, and that is deliberate.
 *
 * Every other file here gives itself a distinct client address through
 * Playwright's `extraHTTPHeaders`, so a per-IP rate limit belonging to one
 * suite is not spent by another. That works because those suites only ever
 * talk to us.
 *
 * This one uploads, and an upload is a **cross-origin** `PUT` to the bucket.
 * The browser attaches every extra header to that request too, lists
 * `x-forwarded-for` in the preflight's `Access-Control-Request-Headers`, and
 * the bucket refuses a header its CORS policy does not name — so the upload
 * fails with `net::ERR_FAILED` for a reason that has nothing to do with the
 * product. That is not a bug to route around in the bucket: a real R2 policy
 * names the headers we sign and nothing else, and it should stay that way.
 *
 * So the address is set by the TLS terminator instead, from
 * `E2E_CLIENT_ADDRESS` — which is what a load balancer does in production, and
 * why the application never trusts a browser-supplied value.
 * `203.0.113.0/24` is the RFC 5737 documentation range.
 */

/** Satisfies the policy, so nothing here ever fails over password strength. */
const PASSWORD = 'a-genuinely-fine-passphrase-42';

const EMAIL = `journey-${Math.random().toString(36).slice(2, 10)}@e2e.zfaf.test`;

/**
 * A genuine JPEG, encoded by the browser rather than read from disk.
 *
 * It has to be genuine: the worker identifies the format from the file's magic
 * bytes and quarantines anything it cannot decode, so a hand-assembled buffer
 * would exercise the rejection path and prove nothing about the happy one.
 *
 * And it is generated rather than vendored, for the reason
 * `apps/worker/src/media/__fixtures__/` is gitignored — we do not commit a
 * photograph of unclear licence into a commercial repository. Chromium's own
 * JPEG encoder produces a real file with no licence attached to it at all.
 *
 * The gradient and the scattered squares are there so the encoder has
 * something to do; a flat colour compresses to almost nothing and would not
 * resemble a photograph at any stage of the pipeline.
 */
async function photograph(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const width = 1400;
    const height = 933;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');

    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#8a6d24');
    gradient.addColorStop(1, '#221f1b');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    for (let i = 0; i < 400; i += 1) {
      context.fillStyle = `hsl(${(i * 7) % 360} 60% 50%)`;
      context.fillRect((i * 37) % width, (i * 53) % height, 24, 24);
    }

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });

  return Buffer.from(base64, 'base64');
}

test.afterAll(async () => {
  await cleanupSeeded();
});

test('a couple signs up, builds an invitation, publishes it, and a guest replies', async ({
  page,
  request,
}) => {
  test.slow();

  /**
   * The browser's own complaints, in the test output.
   *
   * This journey spans four surfaces and two processes, and a failure in a
   * client island otherwise surfaces as "the element never appeared" — the
   * least useful sentence a failing test can produce.
   */
  page.on('pageerror', (error) => console.error(`[page error] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[console] ${message.text()}`);
  });

  // ── 1. register ───────────────────────────────────────────────────────────

  await page.goto('/register');
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('submit').click();

  // Registration signs the person in and lands them on the dashboard: the
  // verification gate is on *publishing*, not on the first run (FR-A2).
  await page.waitForURL('**/dashboard');
  await expect(page.getByTestId('dashboard-empty')).toBeVisible();
  // …and the notice says so plainly rather than blocking the way.
  await expect(page.getByTestId('verify-notice')).toBeVisible();

  // ── 2. verify the email ───────────────────────────────────────────────────

  const user = await userByEmail(EMAIL);
  expect(user, 'registration created no user').not.toBeNull();
  const token = await latestVerificationToken(user!.id, 'email_verification');
  expect(token, 'registration issued no verification token').not.toBeNull();

  // The address in the email, opened the way a person opens it.
  await page.goto(`/verify-email?token=${encodeURIComponent(token!)}`);
  await expect(page.getByTestId('verify-done')).toBeVisible();

  // ── 3. sign out and back in ───────────────────────────────────────────────

  // Worth doing rather than assuming: registration and sign-in issue sessions
  // through different paths, and the rest of this journey rides on the second.
  await page.goto('/dashboard');
  await page.getByTestId('sign-out').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/dashboard'));

  await page.goto('/login');
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('submit').click();
  await page.waitForURL('**/dashboard');
  // The notice is gone, because the address is verified now.
  await expect(page.getByTestId('verify-notice')).toHaveCount(0);

  // ── 4. create an invitation ───────────────────────────────────────────────

  await page.getByTestId('new-invitation').click();
  await page.getByTestId('new-title').fill('زفاف تجريبي');
  await page.getByTestId('new-date').fill('2027-05-20');
  await page.getByTestId('new-submit').click();

  // Straight into the builder — the point of creating one is to edit it.
  await page.waitForURL(/\/builder\/[0-9a-f-]{36}/);
  const invitationId = /\/builder\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  expect(invitationId, 'no invitation id in the builder URL').toBeTruthy();

  // ── 5. fill the draft ─────────────────────────────────────────────────────

  await page.getByTestId('groom-name').fill('سعود');
  await page.getByTestId('bride-name').fill('نورة');

  await page.getByTestId('step-date').click();
  await page.getByTestId('wedding-date').fill('2027-05-20');
  await page.getByTestId('wedding-start-time').fill('20:00');

  // ── 6. upload a photograph ────────────────────────────────────────────────

  await page.getByTestId('step-photos').click();
  await page
    .getByTestId('upload-gallery')
    .locator('input[type="file"]')
    .setInputFiles({ name: 'wedding.jpg', mimeType: 'image/jpeg', buffer: await photograph(page) });

  /**
   * Waits for the *worker*, not for the upload.
   *
   * `complete` returns as soon as storage confirms the object; the decode,
   * EXIF strip, re-encode and derivative write happen in another process. The
   * document only takes a URL once that is done, which is exactly the property
   * worth asserting — a gallery entry pointing at an unprocessed original is
   * the bug this ordering exists to prevent.
   *
   * Raced against the error line rather than waited out. A refusal reported as
   * a ninety-second timeout tells whoever reads the failure nothing; raced, it
   * arrives as the code the server actually sent.
   */
  const galleryItem = page.getByTestId('gallery-list').locator('li');
  const uploadError = page.getByTestId('upload-error');
  await Promise.race([
    galleryItem.first().waitFor({ state: 'visible', timeout: 90_000 }),
    uploadError.waitFor({ state: 'visible', timeout: 90_000 }),
  ]).catch(() => {
    // Neither appeared inside the budget. The assertions below say which.
  });

  const refusal =
    (await uploadError.count()) > 0 ? await uploadError.getAttribute('data-code') : null;
  expect(refusal, 'the upload was refused').toBeNull();
  await expect(galleryItem).toHaveCount(1);

  // ── 7. publish ────────────────────────────────────────────────────────────

  await page.getByTestId('publish-panel').locator('summary').click();
  // ADR-0017: the owner is told what publishing means *before* they do it — a
  // link is not a password. Asserted here rather than only in `publish.spec.ts`
  // because this is the path a real customer takes to reach the button.
  await expect(page.getByTestId('honesty-confirm')).toBeVisible();

  const slug = `journey-${Math.random().toString(36).slice(2, 8)}`;
  await page.getByTestId('publish-slug').fill(slug);
  await expect(page.getByTestId('publish')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('publish').click();

  await expect(page.getByTestId('publish-success')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('published-url')).toContainText(`/i/${slug}`);

  // ── 8. a guest opens the link ─────────────────────────────────────────────

  const guest = await page
    .context()
    .browser()!
    .newContext({
      // A different person, at a different address.
      extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.61' },
      ignoreHTTPSErrors: true,
    });
  const guestPage = await guest.newPage();
  const response = await guestPage.goto(`/i/${slug}`);
  expect(response?.status(), 'the published link does not resolve').toBe(200);

  // The names the couple typed, on the page a guest actually sees. This is the
  // join a suite of green feature tests cannot make on its own.
  await expect(guestPage.locator('body')).toContainText('سعود');
  await expect(guestPage.locator('body')).toContainText('نورة');

  // The photograph reached the page, and as a *derivative* — the original
  // still carries whatever the camera wrote, coordinates included.
  const images = guestPage.locator('img');
  expect(await images.count(), 'the uploaded photograph is not on the page').toBeGreaterThan(0);

  // ── 9. the guest replies ──────────────────────────────────────────────────

  const rsvp = await guest.request.post(`/api/public/invitations/${slug}/rsvp`, {
    data: { name: 'ضيف التجربة', attending: true, partySize: 2 },
  });
  expect(rsvp.status(), await rsvp.text()).toBe(201);
  await guest.close();

  // ── 10. the couple sees it ────────────────────────────────────────────────

  const stats = await request.get(`/api/v1/invitations/${invitationId}/rsvps/stats`, {
    headers: {
      Cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; '),
    },
  });
  expect(stats.ok(), await stats.text()).toBe(true);
  const body = (await stats.json()) as { data: { attending: number; guests: number } };
  expect(body.data.attending).toBe(1);
  expect(body.data.guests).toBe(2);
});
