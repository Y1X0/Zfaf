import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type Browser, type BrowserContext, expect, test } from '@playwright/test';

import {
  type SeededPublished,
  cleanupSeeded,
  seedBuilder,
  seedMedia,
  seedPublished,
  seedStaffSession,
} from './fixtures/seed.js';

/**
 * The authorization matrix (D10.2 — *"generated automatically for every
 * endpoint"*).
 *
 * ## Why it is generated rather than written
 *
 * A hand-written IDOR suite covers the endpoints somebody remembered. The
 * endpoint that gets forgotten is a new one, added under deadline, by whoever
 * was least likely to think about tenant isolation that week. So the route
 * tree on disk is the source: every `route.ts` under `src/app/api`, every HTTP
 * method it exports, and a declared expectation for each actor class. A route
 * with no declaration **fails the suite** — it does not pass quietly.
 *
 * ## The actor classes
 *
 * | class | who |
 * |---|---|
 * | `anonymous` | no cookie at all |
 * | `stranger` | a signed-in customer who owns a *different* invitation |
 * | `owner` | the customer the resource belongs to |
 * | `staffPending` | a real staff account that has not answered its 2FA challenge |
 * | `staff` | a fully authenticated operator |
 *
 * `stranger` is the one that matters. Anonymous access is usually thought
 * about; the signed-in customer poking at somebody else's id is the case that
 * ships broken, and it is the case this matrix exists for.
 *
 * ## What counts as a pass
 *
 * This is an **authorization** matrix, so the two verdicts are about whether
 * the guard let the caller through — not about whether their payload was any
 * good:
 *
 *   • `denied` — 401, 403 or 404. **404 is preferred** for "not yours": a 403
 *     confirms the resource exists, which turns any id-taking endpoint into an
 *     enumeration oracle (docs/12 §3).
 *   • `allowed` — anything else. A 400 for a deliberately malformed body and a
 *     409 for a wrong state both mean the request reached the handler, which is
 *     precisely what such a row claims.
 *
 * And never a 500, for anyone. An unhandled exception on an authorization path
 * is a failure of the guard, not merely of the handler.
 */

const BASE = 'https://127.0.0.1:3100';

/**
 * A distinct client address for this suite (RFC 5737 documentation range).
 *
 * This file submits an RSVP five times — once per actor class — against a real,
 * rate-limited public endpoint. Sharing a client identity with the RSVP suite
 * would spend its budget and fail it for an unrelated reason. A different
 * address is what a different guest actually is.
 */
const CLIENT_ADDRESS = '203.0.113.20';
test.use({ extraHTTPHeaders: { 'x-forwarded-for': CLIENT_ADDRESS } });

/**
 * And a distinct one per actor class.
 *
 * Several endpoints here are rate limited per client — the RSVP edit at five
 * per window, the reset request at five per hour. Running one row through five
 * actors from a single address exhausts the budget partway down the column, and
 * the fourth actor then answers 429: not an authorization refusal, and not
 * something the row is claiming anything about. Separating the addresses makes
 * every cell independent, which is what a matrix is supposed to be.
 */
const ACTOR_ADDRESS: Readonly<Record<ActorClass, string>> = {
  anonymous: '203.0.113.201',
  stranger: '203.0.113.202',
  owner: '203.0.113.203',
  staffPending: '203.0.113.204',
  staff: '203.0.113.205',
};

type ActorClass = 'anonymous' | 'stranger' | 'owner' | 'staffPending' | 'staff';
type Expectation = 'allowed' | 'denied';

interface RouteExpectation {
  /** As it appears on disk, with parameter segments intact. */
  readonly route: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Built with the seeded ids substituted in. */
  readonly path: (fixtures: Fixtures) => string;
  readonly body?: unknown;
  /** For a body that depends on the seeded fixtures. */
  readonly bodyFor?: (fixtures: Fixtures) => unknown;
  readonly expect: Readonly<Record<ActorClass, Expectation>>;
  /** Why this route is public, when it is. Absent for anything protected. */
  readonly publicBecause?: string;
}

interface Fixtures {
  readonly owned: SeededPublished;
  readonly other: SeededPublished;
  /** A pending upload on `owned`, for the media rows. */
  readonly ownedMediaId: string;
}

/**
 * The declared matrix.
 *
 * Ordered as the route tree is, so a reviewer can read it beside `find
 * src/app/api -name route.ts` and see nothing missing.
 */
const MATRIX: readonly RouteExpectation[] = [
  // ── health ────────────────────────────────────────────────────────────────
  {
    route: 'health',
    method: 'GET',
    path: () => '/api/health',
    publicBecause: 'a load balancer has no session',
    expect: {
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'health/deep',
    method: 'GET',
    path: () => '/api/health/deep',
    publicBecause: 'a monitoring probe has no session; component detail needs the token',
    expect: {
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },

  // ── public surfaces ───────────────────────────────────────────────────────
  {
    route: 'public/analytics/event',
    method: 'POST',
    path: () => '/api/public/analytics/event',
    body: { slug: 'nothing-at-all', type: 'view' },
    publicBecause: 'a guest is not signed in; the beacon answers 204 to everything',
    expect: {
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'public/invitations/[slug]/rsvp',
    method: 'POST',
    path: (fixtures) => `/api/public/invitations/${fixtures.owned.slug}/rsvp`,
    body: { attending: true, name: 'ضيف', partySize: 1 },
    publicBecause: 'replying without an account is the product (FR-E1)',
    expect: {
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'public/rsvps/[id]',
    method: 'PATCH',
    // A random id with no edit token: the guest's own reply is reachable only
    // with the token, and nobody else's is reachable at all.
    path: () => '/api/public/rsvps/00000000-0000-4000-8000-000000000000',
    body: { attending: false },
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'denied',
      staffPending: 'denied',
      staff: 'denied',
    },
  },

  // ── authentication ────────────────────────────────────────────────────────
  {
    route: 'v1/auth/register',
    method: 'POST',
    path: () => '/api/v1/auth/register',
    // A malformed body: this row is about *reachability*, not about whether
    // registration works, and creating five accounts per run would be litter.
    body: { email: 'not-an-email' },
    publicBecause: 'somebody without an account is the only person who needs it',
    expect: {
      // Reachable by everyone — it answers 400 to this deliberately malformed
      // body, which is the handler talking, not the guard.
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/login',
    method: 'POST',
    path: () => '/api/v1/auth/login',
    body: { email: 'nobody@example.test', password: 'not-the-password' },
    publicBecause: 'signing in is what a caller without a session does',
    expect: {
      // 401 for everyone, because the credentials are wrong — the point of the
      // row is that an existing session neither helps nor hinders.
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'denied',
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  {
    route: 'v1/auth/session',
    method: 'GET',
    path: () => '/api/v1/auth/session',
    expect: {
      anonymous: 'denied',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/verify-email',
    method: 'POST',
    path: () => '/api/v1/auth/verify-email',
    body: { token: 'not-a-real-token' },
    publicBecause: 'the link is followed before the account is usable',
    expect: {
      // Reachable by anyone; a forged token gets 400 from the handler.
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/verify-email',
    method: 'PUT',
    path: () => '/api/v1/auth/verify-email',
    expect: {
      // Requires a session rather than an address: an endpoint that took an
      // email would send mail to anyone, at anyone's request.
      anonymous: 'denied',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/password-reset',
    method: 'POST',
    path: () => '/api/v1/auth/password-reset',
    body: { email: 'nobody@example.test' },
    publicBecause: 'somebody who cannot sign in is exactly who needs it',
    expect: {
      // 200 for an address with no account, on purpose: any other answer makes
      // this an oracle for which addresses are customers.
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/password-reset',
    method: 'PUT',
    path: () => '/api/v1/auth/password-reset',
    body: { token: 'not-a-real-token', password: 'a-perfectly-fine-password-1' },
    publicBecause: 'the reset link is followed while signed out',
    expect: {
      // `RESET_LINK_INVALID`, from the handler — reachable by anyone.
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },

  // ── two-factor (the endpoints that exist to satisfy the gate) ─────────────
  {
    route: 'v1/auth/two-factor',
    method: 'GET',
    path: () => '/api/v1/auth/two-factor',
    expect: {
      anonymous: 'denied',
      stranger: 'allowed',
      owner: 'allowed',
      // Deliberately reachable while pending: this is how an operator finds
      // out what is being asked of them.
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/two-factor',
    method: 'POST',
    path: () => '/api/v1/auth/two-factor',
    expect: {
      anonymous: 'denied',
      stranger: 'allowed',
      owner: 'allowed',
      // The staff fixtures already hold a confirmed credential, so this is a
      // 409 — the guard let them through and the *state* refused them, which
      // is a different thing and the matrix says so.
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/two-factor',
    method: 'PUT',
    path: () => '/api/v1/auth/two-factor',
    body: { code: '000000' },
    expect: {
      anonymous: 'denied',
      /**
       * 401 for the two customers, and the reason is worth stating because it
       * looks like an inconsistency and is not.
       *
       * The `POST` row above began an enrollment for them, so they now hold an
       * **unconfirmed** credential — and `000000` is not the code for it, which
       * is a wrong-code refusal. The staff fixtures hold a *confirmed* one, so
       * their request is rejected as a conflict before any code is examined.
       *
       * Both are correct. The row's claim is the one they share: a wrong code
       * never confirms anything.
       */
      stranger: 'denied',
      owner: 'denied',
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
  {
    route: 'v1/auth/two-factor',
    method: 'DELETE',
    path: () => '/api/v1/auth/two-factor',
    body: { code: '000000' },
    expect: {
      anonymous: 'denied',
      // 409: nothing enrolled to remove.
      stranger: 'allowed',
      owner: 'allowed',
      // 403, and this is the row that matters — "mandatory, no exception" would
      // mean nothing if the holder could switch it off.
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  {
    route: 'v1/auth/two-factor/verify',
    method: 'POST',
    path: () => '/api/v1/auth/two-factor/verify',
    body: { code: '000000' },
    expect: {
      anonymous: 'denied',
      // A customer owes no second factor, so the endpoint answers "already
      // satisfied" without consuming an attempt — deliberate, so a
      // double-submitted form does not burn one of five tries.
      stranger: 'allowed',
      owner: 'allowed',
      // Owes a challenge, and `000000` is not it.
      staffPending: 'denied',
      staff: 'allowed',
    },
  },

  // ── the owner's own invitation ────────────────────────────────────────────
  // Staff may read the invitation itself…
  ...scopedRead([
    { route: 'v1/invitations/[id]', suffix: '', staff: 'allowed' },
    { route: 'v1/invitations/[id]/analytics', suffix: '/analytics', staff: 'allowed' },
    { route: 'v1/invitations/[id]/qr', suffix: '/qr', staff: 'allowed' },
  ]),
  // …and never the guests. This is the row that must not drift.
  ...scopedRead([
    { route: 'v1/invitations/[id]/rsvps', suffix: '/rsvps', staff: 'denied' },
    { route: 'v1/invitations/[id]/rsvps/stats', suffix: '/rsvps/stats', staff: 'denied' },
    { route: 'v1/invitations/[id]/rsvps/export', suffix: '/rsvps/export', staff: 'denied' },
  ]),
  {
    route: 'v1/invitations/[id]/document',
    method: 'PATCH',
    path: (fixtures) => `/api/v1/invitations/${fixtures.owned.invitationId}/document`,
    // The seeded draft's current version: an autosave carries the version it
    // read, and a stale one is a conflict rather than a permission failure —
    // which is exactly the distinction this row is checking does not blur.
    bodyFor: (fixtures: Fixtures) => ({
      baseVersion: fixtures.owned.draftVersion,
      patch: [{ op: 'replace', path: '/content/couple/message', value: 'أهلاً' }],
    }),
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'allowed',
      staffPending: 'denied',
      // Staff may moderate an invitation; they may not edit it.
      staff: 'denied',
    },
  },
  {
    route: 'v1/invitations/[id]/publish',
    method: 'POST',
    path: (fixtures) => `/api/v1/invitations/${fixtures.owned.invitationId}/publish`,
    body: {},
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      // Republishing is legitimate — an owner fixing a typo after sending the
      // link is the flow FR-D/FR-B exist for.
      owner: 'allowed',
      staffPending: 'denied',
      // Staff may moderate an invitation. Publishing one is not moderation.
      staff: 'denied',
    },
  },
  {
    route: 'v1/invitations/[id]/publish',
    method: 'PATCH',
    path: (fixtures) => `/api/v1/invitations/${fixtures.owned.invitationId}/publish`,
    body: { visibility: 'UNLISTED' },
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'allowed',
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  {
    route: 'v1/invitations/[id]/publish',
    method: 'DELETE',
    path: (fixtures) => `/api/v1/invitations/${fixtures.other.invitationId}/publish`,
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      // Unpublishing somebody else's invitation is the destructive IDOR; the
      // owner column is the only one allowed to be `allowed` here.
      owner: 'denied',
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  {
    route: 'v1/invitations/[id]/rsvps/[rsvpId]',
    method: 'DELETE',
    path: (fixtures) =>
      `/api/v1/invitations/${fixtures.owned.invitationId}/rsvps/00000000-0000-4000-8000-000000000000`,
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      // The invitation is the owner's, the reply id is not real: 404, which is
      // the same answer a stranger gets and reveals nothing either way.
      owner: 'denied',
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  // ── the invitation collection (docs/23 §7) ────────────────────────────────
  {
    route: 'v1/invitations',
    method: 'GET',
    path: () => '/api/v1/invitations',
    expect: {
      anonymous: 'denied',
      // Everyone signed in may list — *their own*. The scope is what makes
      // that safe, and `invitations.spec.ts` is where it is proven; this cell
      // only claims the guard admits them.
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'denied',
      /**
       * Refused, and the reason is worth stating.
       *
       * Staff carry `ownerId: null`, which every repository reads as "no owner
       * constraint" — so the obvious spelling of this handler would have
       * answered a staff session with *every tenant's* invitations, from a
       * route with none of `/api/admin`'s protections. `customerScopeFor`
       * exists because of this cell.
       */
      staff: 'denied',
    },
  },
  {
    route: 'v1/invitations',
    method: 'POST',
    path: () => '/api/v1/invitations',
    // No such template, so the handler answers 404 — which is an *allowed*
    // verdict here: the request reached the handler, which is all this row
    // claims. Using a real template key would create rows on five actors.
    body: {
      templateKey: 'no-such-template-for-the-matrix',
      title: 'IDOR matrix',
      eventDate: '2027-01-01',
      locale: 'ar',
    },
    expect: {
      anonymous: 'denied',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'denied',
      // The row that matters. Platform staff get an unconstrained scope, so
      // letting them create would own the invitation to a staff account and
      // count *every* tenant's invitations against one customer's plan limit.
      staff: 'denied',
    },
  },

  // ── media (D4.2, D4.7) ────────────────────────────────────────────────────
  {
    route: 'v1/media/upload-url',
    method: 'POST',
    // Deliberately the *other* owner's invitation: the interesting question
    // for an upload endpoint is not whether a stranger may upload, it is
    // whether they may upload *into somebody else's invitation*.
    bodyFor: (fixtures: Fixtures) => ({
      invitationId: fixtures.other.invitationId,
      purpose: 'gallery',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    }),
    path: () => '/api/v1/media/upload-url',
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      // `owner` owns `owned`, not `other` — so the owner column is denied
      // here too, and that is the point of pointing the row at `other`.
      owner: 'denied',
      staffPending: 'denied',
      // Staff may moderate an invitation. Adding photos to it is not
      // moderation, and their scope would place the asset under a staff id.
      staff: 'denied',
    },
  },
  {
    route: 'v1/media/[id]',
    method: 'GET',
    path: (fixtures) => `/api/v1/media/${fixtures.ownedMediaId}`,
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'allowed',
      staffPending: 'denied',
      // An unconstrained scope finds the row. Staff reading a customer's photo
      // is a moderation capability the console does not offer, but the scope
      // is what it is and this cell states the truth rather than a wish.
      staff: 'allowed',
    },
  },
  {
    route: 'v1/media/[id]/complete',
    method: 'POST',
    path: (fixtures) => `/api/v1/media/${fixtures.ownedMediaId}/complete`,
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      // 409 `OBJECT_MISSING` — nothing was ever PUT. The request reached the
      // handler, which is what "allowed" means in this matrix.
      owner: 'allowed',
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  {
    route: 'v1/media/[id]',
    method: 'DELETE',
    path: (fixtures) => `/api/v1/media/${fixtures.ownedMediaId}`,
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      // Runs last of the media rows and actually soft-deletes. Nothing after
      // it reads this asset, and `GET` above has already run.
      owner: 'allowed',
      staffPending: 'denied',
      staff: 'denied',
    },
  },

  {
    route: 'v1/slugs/available',
    method: 'GET',
    path: () => '/api/v1/slugs/available?slug=some-candidate',
    expect: {
      anonymous: 'denied',
      stranger: 'allowed',
      owner: 'allowed',
      staffPending: 'denied',
      staff: 'allowed',
    },
  },

  // ── the admin console ─────────────────────────────────────────────────────
  ...staffOnly([
    { route: 'admin/users', method: 'GET', path: '/api/admin/users' },
    { route: 'admin/invitations', method: 'GET', path: '/api/admin/invitations' },
    { route: 'admin/audit-logs', method: 'GET', path: '/api/admin/audit-logs' },
  ]),
  {
    route: 'admin/invitations/[id]/moderate',
    method: 'POST',
    path: (fixtures) => `/api/admin/invitations/${fixtures.other.invitationId}/moderate`,
    body: { action: 'suspend', reason: 'idor matrix' },
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'denied',
      staffPending: 'denied',
      staff: 'allowed',
    },
  },
  /**
   * Last, and that placement is load-bearing.
   *
   * Signing out ends the session it is called with, so every row after it would
   * run without one and report a refusal that says nothing about authorization.
   */
  {
    route: 'v1/auth/logout',
    method: 'POST',
    path: () => '/api/v1/auth/logout',
    publicBecause: 'a caller must be able to leave whatever state their session is in',
    expect: {
      anonymous: 'allowed',
      stranger: 'allowed',
      owner: 'allowed',
      // Deliberately reachable while a challenge is outstanding: refusing to
      // let somebody *leave* until they finish authenticating protects nothing.
      staffPending: 'allowed',
      staff: 'allowed',
    },
  },
];

/**
 * Reads scoped to one invitation.
 *
 * `staff` differs by route on purpose, and the line is drawn exactly where
 * `can()` draws it: staff may see and moderate an invitation, and may never
 * read guest personal data — `rsvp:read`, `rsvp:export` and `rsvp:delete` are
 * denied to a superadmin (docs/09 §3.3). So the invitation, its analytics and
 * its QR code are staff-readable; the replies are not.
 */
function scopedRead(
  routes: readonly { route: string; suffix: string; staff: Expectation }[],
): RouteExpectation[] {
  return routes.map((entry) => ({
    route: entry.route,
    method: 'GET' as const,
    path: (fixtures: Fixtures) =>
      `/api/v1/invitations/${fixtures.owned.invitationId}${entry.suffix}`,
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'allowed',
      staffPending: 'denied',
      staff: entry.staff,
    } as const,
  }));
}

function staffOnly(
  routes: readonly { route: string; method: 'GET'; path: string }[],
): RouteExpectation[] {
  return routes.map((entry) => ({
    route: entry.route,
    method: entry.method,
    path: () => entry.path,
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'denied',
      staffPending: 'denied',
      staff: 'allowed',
    } as const,
  }));
}

// ── running it ──────────────────────────────────────────────────────────────

let fixtures: Fixtures;
const cookies: Partial<Record<ActorClass, string>> = {};

test.beforeAll(async () => {
  const owned = await seedPublished();
  const other = await seedPublished();
  fixtures = { owned, other, ownedMediaId: await seedMedia(owned) };

  cookies.owner = owned.sessionToken;
  cookies.stranger = (await seedBuilder()).sessionToken;
  cookies.staffPending = (await seedStaffSession({ twoFactor: 'unverified' })).sessionToken;
  cookies.staff = (await seedStaffSession({ twoFactor: 'verified' })).sessionToken;
});

test.afterAll(async () => {
  await cleanupSeeded();
});

async function contextFor(browser: Browser, actor: ActorClass): Promise<BrowserContext> {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': ACTOR_ADDRESS[actor] },
  });
  const token = cookies[actor];
  if (token) {
    await context.addCookies([
      {
        name: '__Host-zfaf_session',
        value: token,
        url: BASE,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  }
  return context;
}

const ACTORS: readonly ActorClass[] = ['anonymous', 'stranger', 'owner', 'staffPending', 'staff'];

for (const entry of MATRIX) {
  for (const actor of ACTORS) {
    const expected = entry.expect[actor];
    test(`${entry.method} ${entry.route} — ${actor} is ${expected}`, async ({ browser }) => {
      const context = await contextFor(browser, actor);
      const path = entry.path(fixtures);

      const body = entry.bodyFor ? entry.bodyFor(fixtures) : entry.body;
      const response = await context.request.fetch(path, {
        method: entry.method,
        ...(body === undefined ? {} : { data: body }),
        maxRedirects: 0,
      });
      const status = response.status();
      await context.close();

      const refused = [401, 403, 404].includes(status);
      expect(
        refused,
        `${entry.method} ${path} as ${actor} answered ${status}, expected ${expected}`,
      ).toBe(expected === 'denied');

      // Never a 500, whoever asks. An unhandled exception on an authorization
      // path is a failure of the guard, not merely of the handler.
      expect(status, `${entry.method} ${path} as ${actor} produced a server error`).toBeLessThan(
        500,
      );
    });
  }
}

// ── the matrix is generated, not trusted ────────────────────────────────────

test('every route and method on disk has a declared expectation', () => {
  /**
   * The check that makes this a *matrix* rather than a list.
   *
   * A new endpoint that nobody added here fails this test, which is the whole
   * point: the endpoint most likely to have an authorization hole is the one
   * added last, by whoever was busiest.
   */
  const root = new URL('../src/app/api', import.meta.url).pathname;
  const found = new Set<string>();

  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) {
        walk(full, prefix ? `${prefix}/${name}` : name);
        continue;
      }
      if (name !== 'route.ts' && name !== 'route.tsx') continue;

      const source = readFileSync(full, 'utf8');
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        if (new RegExp(`export (?:async )?function ${method}\\b`).test(source)) {
          found.add(`${method} ${prefix}`);
        }
      }
    }
  };
  walk(root, '');

  const declared = new Set(MATRIX.map((entry) => `${entry.method} ${entry.route}`));

  const undeclared = [...found].filter((key) => !declared.has(key)).sort();
  const stale = [...declared].filter((key) => !found.has(key)).sort();

  expect(undeclared, 'these endpoints exist but have no authorization expectation').toEqual([]);
  expect(stale, 'these expectations name endpoints that no longer exist').toEqual([]);
});

test('every mutating endpoint refuses a cross-site Origin', async ({ browser }) => {
  /**
   * CSRF layer 2 (docs/09 §5), checked the same way the matrix is: against the
   * route tree rather than a list.
   *
   * `SameSite=Lax` is layer 1 and covers the majority, and docs/09 says in a
   * warning box that it is not sufficient alone. So every mutating handler
   * validates `Origin` — and the endpoint added next month has to as well,
   * which is what this test is for.
   *
   * The request carries a real session cookie: a guard that only refused
   * *unauthenticated* cross-site writes would refuse nothing that matters,
   * since CSRF is the attack where the victim's cookie is attached.
   */
  const evil = 'https://attacker.example';
  const context = await browser.newContext({
    extraHTTPHeaders: { origin: evil, 'x-forwarded-for': CLIENT_ADDRESS },
  });
  await context.addCookies([
    {
      name: '__Host-zfaf_session',
      value: cookies.owner!,
      url: BASE,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  const mutating = MATRIX.filter((entry) => entry.method !== 'GET');
  const accepted: string[] = [];

  for (const entry of mutating) {
    const body = entry.bodyFor ? entry.bodyFor(fixtures) : entry.body;
    const response = await context.request.fetch(entry.path(fixtures), {
      method: entry.method,
      ...(body === undefined ? {} : { data: body }),
      maxRedirects: 0,
    });
    if (response.status() !== 403) {
      accepted.push(`${entry.method} ${entry.route} answered ${response.status()}`);
    }
  }
  await context.close();

  expect(accepted, 'these mutating endpoints accepted a cross-site request').toEqual([]);
});

test('a same-origin request is not caught by the CSRF guard', async ({ browser }) => {
  // The control. Without it, the test above would also pass if the guard
  // rejected everything — including the application's own forms.
  const context = await browser.newContext({
    // Its own address: the matrix above already spent this endpoint's
    // per-client budget, and a 429 here would look like a CSRF rejection.
    extraHTTPHeaders: { origin: BASE, 'x-forwarded-for': '203.0.113.21' },
  });
  const response = await context.request.post('/api/v1/auth/password-reset', {
    data: { email: 'nobody@example.test' },
  });
  expect(response.status()).toBe(200);
  await context.close();
});

test('every route that is reachable anonymously says why', () => {
  // A public endpoint is a decision. Requiring the reason in writing is what
  // stops one becoming public by omission.
  const publicRoutes = MATRIX.filter((entry) => entry.expect.anonymous === 'allowed');
  for (const entry of publicRoutes) {
    expect(
      entry.publicBecause,
      `${entry.method} ${entry.route} is anonymous-allowed with no stated reason`,
    ).toBeTruthy();
  }
});
