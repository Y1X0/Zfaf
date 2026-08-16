import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { TokenGenerator } from '../../identity/ports/token-generator.js';
import type {
  InvitationRepository,
  PublicInvitationView,
} from '../../invitation/ports/invitation-repository.js';
import {
  createSnapshot,
  type PublishedSnapshot,
} from '../../invitation/domain/published-snapshot.js';
import { validDraft } from '../../testing/draft-fixture.js';
import { resolveDocument } from '../../invitation/domain/resolve-document.js';
import type {
  EditRsvpCommand,
  EditRsvpOutcome,
  RsvpRepository,
  SubmitRsvpCommand,
  SubmitRsvpOutcome,
} from '../ports/rsvp-repository.js';
import { editRsvp, submitRsvp } from './submit-rsvp.js';

/**
 * The order of the abuse controls, and what each one is for.
 *
 * These are the tests that make the security claims in this use case
 * checkable: that a bot is answered with a convincing success and nothing is
 * written, that the party-size limit comes from the published snapshot rather
 * than the form, and that an invitation nobody may read cannot be replied to.
 */

const NOW = new Date('2026-08-16T10:00:00.000Z');

function snapshotFor(
  overrides: Partial<{ enabled: boolean; deadline: string | null; maxPartySize: number }> = {},
): PublishedSnapshot {
  const draft = validDraft();
  const resolved = resolveDocument(draft, { publishedAt: NOW.toISOString() });
  if (!resolved.ok) throw new Error('fixture is not publishable');

  // Rebuilt through `createSnapshot` so the override is subject to the same
  // schema a real snapshot is.
  const rebuilt = createSnapshot({
    ...resolved.snapshot,
    content: {
      ...resolved.snapshot.content,
      rsvp: { ...resolved.snapshot.content.rsvp, ...overrides },
    },
  });
  if (!rebuilt.ok) throw new Error(`override is invalid: ${JSON.stringify(rebuilt.errors)}`);
  return rebuilt.snapshot;
}

function viewFor(overrides: Partial<PublicInvitationView> = {}): PublicInvitationView {
  return {
    invitationId: 'inv-1',
    status: 'PUBLISHED',
    visibility: 'UNLISTED',
    snapshot: snapshotFor(),
    versionNumber: 1,
    expiresAt: null,
    ...overrides,
  };
}

class FakeRsvpRepository implements RsvpRepository {
  readonly submissions: SubmitRsvpCommand[] = [];
  readonly edits: EditRsvpCommand[] = [];
  editOutcome: EditRsvpOutcome = { ok: true, rsvpId: 'rsvp-1' };

  async submit(input: SubmitRsvpCommand): Promise<SubmitRsvpOutcome> {
    this.submissions.push(input);
    return { ok: true, rsvpId: input.id, created: true };
  }

  async edit(input: EditRsvpCommand): Promise<EditRsvpOutcome> {
    this.edits.push(input);
    return this.editOutcome;
  }

  async listInScope() {
    return { rows: [], total: 0 };
  }

  async statsInScope() {
    return null;
  }

  async allInScope() {
    return [];
  }

  async deleteInScope() {
    return false;
  }
}

let rsvps: FakeRsvpRepository;
let view: PublicInvitationView | null;
let humanCheckAnswer: boolean;

const clock: Clock = { now: () => NOW };
const ids: IdGenerator = { uuid: () => 'rsvp-generated', token: () => 'token' };
const tokens: TokenGenerator = {
  generate: () => 'plain-edit-token',
  hash: (value: string) => new TextEncoder().encode(value),
  verify: () => true,
};

const invitations = {
  findPublishedBySlug: async () => view,
} as unknown as InvitationRepository;

function deps() {
  return {
    invitations,
    rsvps,
    clock,
    ids,
    tokens,
    humanCheck: { verify: async () => humanCheckAnswer },
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return { name: 'خالد العتيبي', attending: true, partySize: 2, ...overrides };
}

beforeEach(() => {
  rsvps = new FakeRsvpRepository();
  view = viewFor();
  humanCheckAnswer = true;
});

// ── the honeypot ────────────────────────────────────────────────────────────

describe('the honeypot (D7.3)', () => {
  it('answers a bot with a success it can believe', async () => {
    const result = await submitRsvp(
      {
        slug: 'x',
        body: body(),
        honeypot: 'http://spam',
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      deps(),
    );

    // Telling a bot it failed just makes it try differently.
    expect(result.ok).toBe(true);
    if (result.ok) expect('discarded' in result).toBe(true);
  });

  it('writes nothing at all', async () => {
    await submitRsvp(
      {
        slug: 'x',
        body: body(),
        honeypot: 'anything',
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      deps(),
    );
    expect(rsvps.submissions).toEqual([]);
  });

  it('does not trip on the empty field a real guest leaves behind', async () => {
    const result = await submitRsvp(
      {
        slug: 'x',
        body: body(),
        honeypot: '   ',
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      deps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect('discarded' in result).toBe(false);
  });
});

// ── the human check ─────────────────────────────────────────────────────────

describe('the human check (D7.3)', () => {
  it('is skipped while the invitation is quiet', async () => {
    const verify = vi.fn(async () => true);
    await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: false, humanCheckToken: null },
      { ...deps(), humanCheck: { verify } },
    );
    // A challenge in front of every guest costs replies from exactly the
    // people least likely to persist.
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses when the invitation is busy and the check fails', async () => {
    humanCheckAnswer = false;
    const result = await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: true, humanCheckToken: 'bad' },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('HUMAN_CHECK_REQUIRED');
    expect(rsvps.submissions).toEqual([]);
  });

  it('lets the reply through when the check passes', async () => {
    const result = await submitRsvp(
      {
        slug: 'x',
        body: body(),
        honeypot: null,
        requiresHumanCheck: true,
        humanCheckToken: 'good',
      },
      deps(),
    );
    expect(result.ok).toBe(true);
  });
});

// ── the invitation's own rules ──────────────────────────────────────────────

describe('what the invitation allows', () => {
  it('enforces the party limit from the snapshot, not the form', async () => {
    // The form is markup a guest can edit. The snapshot is what the couple
    // published, and it is what decides.
    view = viewFor({ snapshot: snapshotFor({ maxPartySize: 3 }) });

    const result = await submitRsvp(
      {
        slug: 'x',
        body: body({ partySize: 9 }),
        honeypot: null,
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'REFUSED') {
      expect(result.failure.reason).toBe('PARTY_TOO_LARGE');
    } else {
      expect.unreachable('expected a refusal');
    }
  });

  it('refuses when the couple turned replies off', async () => {
    view = viewFor({ snapshot: snapshotFor({ enabled: false }) });
    const result = await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: false, humanCheckToken: null },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'REFUSED') {
      expect(result.failure.reason).toBe('RSVP_DISABLED');
    }
  });

  it('refuses an invitation nobody may read, with the page’s own answer', async () => {
    for (const status of ['DRAFT', 'PAUSED', 'EXPIRED', 'SUSPENDED'] as const) {
      view = viewFor({ status });
      const result = await submitRsvp(
        {
          slug: 'x',
          body: body(),
          honeypot: null,
          requiresHumanCheck: false,
          humanCheckToken: null,
        },
        deps(),
      );
      // The same 404 the page gives. A different answer here would tell a
      // stranger which slugs exist.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('NOT_FOUND');
    }
  });

  it('refuses an invitation past its expiry, before any sweep has run', async () => {
    view = viewFor({ expiresAt: new Date(NOW.getTime() - 1) });
    const result = await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: false, humanCheckToken: null },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NOT_FOUND');
  });

  it('refuses a slug nobody owns', async () => {
    view = null;
    const result = await submitRsvp(
      {
        slug: 'nope',
        body: body(),
        honeypot: null,
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NOT_FOUND');
  });
});

// ── what is written ─────────────────────────────────────────────────────────

describe('what reaches the repository', () => {
  it('carries the identity hash, not the raw pair', async () => {
    await submitRsvp(
      {
        slug: 'x',
        body: body({ phone: '0501234567' }),
        honeypot: null,
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      deps(),
    );

    const written = rsvps.submissions[0];
    expect(written?.dedupeHash).toBeInstanceOf(Uint8Array);
    expect(written?.dedupeHash.length).toBe(32);
  });

  it('stores the edit token only as a hash, and returns the plaintext once', async () => {
    const result = await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: false, humanCheckToken: null },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || 'discarded' in result) return;
    expect(result.editToken).toBe('plain-edit-token');

    const written = rsvps.submissions[0];
    expect(new TextDecoder().decode(written?.editTokenHash)).toBe('plain-edit-token');
    // Which is to say the row holds the hash, and the plaintext exists only in
    // the response that delivers it (ADR-0006).
  });

  it('zeroes the party size for a guest who declines', async () => {
    // Otherwise a declining guest with "4" still in the field would be counted
    // in the catering numbers.
    await submitRsvp(
      {
        slug: 'x',
        body: body({ attending: false, partySize: 4 }),
        honeypot: null,
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      deps(),
    );
    expect(rsvps.submissions[0]?.partySize).toBe(0);
  });

  it('marks the source rather than trusting the client to', async () => {
    await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: false, humanCheckToken: null },
      deps(),
    );
    expect(rsvps.submissions[0]?.source).toBe('public');
  });
});

describe('telling the owner (D7.7)', () => {
  it('notifies after a reply is recorded', async () => {
    const notifyOwner = vi.fn(async () => {});
    await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: false, humanCheckToken: null },
      { ...deps(), notifyOwner },
    );
    expect(notifyOwner).toHaveBeenCalledOnce();
  });

  it('records the reply even when the mail server is down', async () => {
    // A guest's reply is the one thing this product exists to capture. Losing
    // it because a notification failed would be the worst possible trade.
    const notifyOwner = vi.fn(async () => {
      throw new Error('smtp is down');
    });

    const result = await submitRsvp(
      { slug: 'x', body: body(), honeypot: null, requiresHumanCheck: false, humanCheckToken: null },
      { ...deps(), notifyOwner },
    );

    expect(result.ok).toBe(true);
    expect(rsvps.submissions).toHaveLength(1);
  });

  it('never notifies about a reply the honeypot discarded', async () => {
    const notifyOwner = vi.fn(async () => {});
    await submitRsvp(
      {
        slug: 'x',
        body: body(),
        honeypot: 'bot',
        requiresHumanCheck: false,
        humanCheckToken: null,
      },
      { ...deps(), notifyOwner },
    );
    expect(notifyOwner).not.toHaveBeenCalled();
  });
});

// ── corrections ─────────────────────────────────────────────────────────────

describe('editRsvp (D7.4)', () => {
  it('passes the token as a hash and the window as a predicate', async () => {
    await editRsvp(
      { rsvpId: 'rsvp-1', editToken: 'secret', body: body() },
      { rsvps, clock, tokens },
    );

    const edit = rsvps.edits[0];
    expect(new TextDecoder().decode(edit?.editTokenHash)).toBe('secret');
    // Twenty-four hours before now: a reply older than this is out of time.
    expect(edit?.editableUntil.getTime()).toBe(NOW.getTime() - 24 * 60 * 60 * 1000);
  });

  it('reports a wrong token as simply not found', async () => {
    rsvps.editOutcome = { ok: false, error: 'BAD_TOKEN' };
    const result = await editRsvp(
      { rsvpId: 'rsvp-1', editToken: 'wrong', body: body() },
      { rsvps, clock, tokens },
    );

    expect(result.ok).toBe(false);
    // Distinguishing a wrong token from an unknown id would confirm that a
    // given response exists.
    if (!result.ok) expect(result.failure.code).toBe('NOT_FOUND');
  });

  it('tells a guest who is simply too late', async () => {
    rsvps.editOutcome = { ok: false, error: 'WINDOW_CLOSED' };
    const result = await editRsvp(
      { rsvpId: 'rsvp-1', editToken: 'right', body: body() },
      { rsvps, clock, tokens },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('WINDOW_CLOSED');
  });

  it('validates the correction as strictly as the original', async () => {
    const result = await editRsvp(
      { rsvpId: 'rsvp-1', editToken: 'right', body: { name: 'x', attending: true, partySize: 1 } },
      { rsvps, clock, tokens },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('INVALID');
    expect(rsvps.edits).toEqual([]);
  });
});
