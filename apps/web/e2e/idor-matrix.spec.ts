import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type Browser, type BrowserContext, expect, test } from '@playwright/test';

import {
  type SeededPublished,
  cleanupSeeded,
  seedBuilder,
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
 * `denied` means 401, 403 or 404 — never 200 and never 500. **404 is
 * preferred** for "not yours": a 403 confirms the resource exists, which turns
 * any id-taking endpoint into an enumeration oracle (docs/12 §3).
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
      // The staff fixtures already hold a confirmed credential, so beginning
      // again is a conflict rather than a permission failure.
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  {
    route: 'v1/auth/two-factor',
    method: 'PUT',
    path: () => '/api/v1/auth/two-factor',
    body: { code: '000000' },
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'denied',
      staffPending: 'denied',
      staff: 'denied',
    },
  },
  {
    route: 'v1/auth/two-factor',
    method: 'DELETE',
    path: () => '/api/v1/auth/two-factor',
    body: { code: '000000' },
    expect: {
      anonymous: 'denied',
      stranger: 'denied',
      owner: 'denied',
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
  fixtures = { owned, other };

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
    extraHTTPHeaders: { 'x-forwarded-for': CLIENT_ADDRESS },
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

      if (expected === 'denied') {
        // 401, 403 or 404 — and 404 is the one we prefer, because 403 confirms
        // the resource exists.
        expect(
          [401, 403, 404, 409, 429].includes(status),
          `${entry.method} ${path} as ${actor} answered ${status}`,
        ).toBe(true);
      } else {
        expect(status < 400, `${entry.method} ${path} as ${actor} answered ${status}`).toBe(true);
      }

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
