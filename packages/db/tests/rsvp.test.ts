import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { type Actor, createSnapshot, rsvpDedupeHash, tenantScopeFor } from '@zfaf/core';
import { PrismaInvitationRepository } from '../src/repositories/invitation.repository.js';
import { PrismaRsvpRepository } from '../src/repositories/rsvp.repository.js';
import {
  resetDatabase,
  seedInvitation,
  seedTemplate,
  seedUser,
  snapshotFixture,
  testClient,
} from './helpers/database.js';

/**
 * RSVP against real PostgreSQL (D7.2, D7.4, D7.5).
 *
 * The milestone's exit criterion is a concurrency claim — fifty simultaneous
 * submissions, duplicates among them, producing exactly correct counters — and
 * a concurrency claim has no meaningful mock. What is under test here is the
 * unique index, the upsert, and whether `increment` inside a transaction
 * actually holds when fifty of them arrive at once.
 */

let prisma: PrismaClient;
let rsvps: PrismaRsvpRepository;
let invitations: PrismaInvitationRepository;
let templateVersionId: string;
let ownerId: string;
let invitationId: string;

function scopeFor(userId: string) {
  const actor: Actor = {
    kind: 'user',
    userId,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 's',
    memberships: [],
  };
  const scope = tenantScopeFor(actor);
  if (!scope) throw new Error('expected a scope');
  return scope;
}

/** A submission command, with the identity hash the domain would compute. */
function command(overrides: {
  name: string;
  attending?: boolean;
  partySize?: number;
  phone?: string | null;
  note?: string | null;
  invitation?: string;
}) {
  const target = overrides.invitation ?? invitationId;
  const phone = overrides.phone ?? null;
  return {
    id: randomUUID(),
    invitationId: target,
    name: overrides.name,
    attending: overrides.attending ?? true,
    partySize: overrides.partySize ?? 1,
    phone,
    note: overrides.note ?? null,
    dedupeHash: rsvpDedupeHash({ invitationId: target, name: overrides.name, phone }),
    editTokenHash: new Uint8Array(32).fill(7),
    source: 'public',
    now: new Date(),
  };
}

async function counters() {
  const row = await prisma.invitation.findUniqueOrThrow({
    where: { id: invitationId },
    select: { rsvpYesCount: true, rsvpNoCount: true, rsvpGuestCount: true },
  });
  return row;
}

beforeAll(() => {
  prisma = testClient();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  rsvps = new PrismaRsvpRepository(prisma);
  invitations = new PrismaInvitationRepository(prisma);
  templateVersionId = await seedTemplate(prisma);
  ownerId = await seedUser(prisma);
  invitationId = await seedInvitation(prisma, { ownerId, templateVersionId });
});

// ── one guest, one row ──────────────────────────────────────────────────────

describe('deduplication', () => {
  it('records a reply and moves the counters', async () => {
    const result = await rsvps.submit(command({ name: 'خالد', partySize: 3 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(true);

    expect(await counters()).toEqual({ rsvpYesCount: 1, rsvpNoCount: 0, rsvpGuestCount: 3 });
  });

  it('updates rather than duplicates when a guest submits twice', async () => {
    // The double-tap on a slow connection: the button appears to do nothing,
    // so it gets pressed again.
    await rsvps.submit(command({ name: 'خالد', partySize: 3 }));
    const second = await rsvps.submit(command({ name: 'خالد', partySize: 4 }));

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.created).toBe(false);

    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(1);
    expect(await counters()).toEqual({ rsvpYesCount: 1, rsvpNoCount: 0, rsvpGuestCount: 4 });
  });

  it('treats the Arabic spellings of one name as one guest', async () => {
    await rsvps.submit(command({ name: 'أحمد' }));
    await rsvps.submit(command({ name: 'احمد' }));
    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(1);
  });

  it('keeps two guests apart when only their phone differs', async () => {
    await rsvps.submit(command({ name: 'محمد', phone: '0501111111' }));
    await rsvps.submit(command({ name: 'محمد', phone: '0502222222' }));
    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(2);
    expect((await counters()).rsvpYesCount).toBe(2);
  });

  it('moves a guest who changes their mind, without double counting', async () => {
    await rsvps.submit(command({ name: 'خالد', attending: true, partySize: 3 }));
    await rsvps.submit(command({ name: 'خالد', attending: false, partySize: 0 }));

    expect(await counters()).toEqual({ rsvpYesCount: 0, rsvpNoCount: 1, rsvpGuestCount: 0 });
  });
});

// ── the exit criterion ──────────────────────────────────────────────────────

describe('fifty simultaneous replies (M7 exit criterion)', () => {
  it('produces exactly correct counters, duplicates included', async () => {
    // Thirty distinct guests; twenty of them submitting a second time at the
    // same instant. Every submission is in flight together.
    const distinct = 30;
    const duplicates = 20;

    const submissions = [
      ...Array.from({ length: distinct }, (_, index) =>
        command({
          name: `ضيف-${index}`,
          attending: index % 5 !== 0,
          partySize: index % 5 !== 0 ? 2 : 0,
        }),
      ),
      ...Array.from({ length: duplicates }, (_, index) =>
        command({
          name: `ضيف-${index}`,
          attending: index % 5 !== 0,
          partySize: index % 5 !== 0 ? 2 : 0,
        }),
      ),
    ];

    const results = await Promise.allSettled(submissions.map((input) => rsvps.submit(input)));

    // Some may lose a serialisation race and be retried by a real caller; what
    // must never happen is a duplicate row or a wrong count.
    const settled = results.filter((result) => result.status === 'fulfilled');
    expect(settled.length).toBeGreaterThan(0);

    const rows = await prisma.rsvp.findMany({
      where: { invitationId },
      select: { name: true, attending: true, partySize: true },
    });

    // One row per distinct guest, whatever the interleaving.
    expect(rows).toHaveLength(distinct);
    expect(new Set(rows.map((row) => row.name)).size).toBe(distinct);

    // And the counters agree with the rows, exactly.
    const expected = rows.reduce(
      (total, row) => ({
        rsvpYesCount: total.rsvpYesCount + (row.attending ? 1 : 0),
        rsvpNoCount: total.rsvpNoCount + (row.attending ? 0 : 1),
        rsvpGuestCount: total.rsvpGuestCount + (row.attending ? row.partySize : 0),
      }),
      { rsvpYesCount: 0, rsvpNoCount: 0, rsvpGuestCount: 0 },
    );

    expect(await counters()).toEqual(expected);
  }, 60_000);
});

// ── corrections ─────────────────────────────────────────────────────────────

describe('a guest correcting their own reply (D7.4)', () => {
  const token = new Uint8Array(32).fill(7);

  it('applies the change and moves the counters with it', async () => {
    const submitted = await rsvps.submit(command({ name: 'خالد', partySize: 2 }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const outcome = await rsvps.edit({
      rsvpId: submitted.rsvpId,
      editTokenHash: token,
      attending: true,
      partySize: 5,
      note: 'سنصل متأخرين',
      now: new Date(),
      editableUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    expect(outcome.ok).toBe(true);
    expect((await counters()).rsvpGuestCount).toBe(5);
  });

  it('refuses a wrong token, and says nothing about why', async () => {
    const submitted = await rsvps.submit(command({ name: 'خالد' }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const outcome = await rsvps.edit({
      rsvpId: submitted.rsvpId,
      editTokenHash: new Uint8Array(32).fill(9),
      attending: false,
      partySize: 0,
      note: null,
      now: new Date(),
      editableUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('BAD_TOKEN');
    // And nothing moved.
    expect((await counters()).rsvpYesCount).toBe(1);
  });

  it('refuses once the window has closed', async () => {
    const submitted = await rsvps.submit(command({ name: 'خالد' }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const outcome = await rsvps.edit({
      rsvpId: submitted.rsvpId,
      editTokenHash: token,
      attending: false,
      partySize: 0,
      note: null,
      now: new Date(),
      // As if the reply had been made two days ago.
      editableUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('WINDOW_CLOSED');
  });
});

// ── isolation ───────────────────────────────────────────────────────────────

describe('who can read a guest list', () => {
  beforeEach(async () => {
    await rsvps.submit(command({ name: 'خالد', partySize: 2 }));
    await rsvps.submit(command({ name: 'سارة', attending: false, partySize: 0 }));
  });

  it('shows the owner their own replies', async () => {
    const page = await rsvps.listInScope(invitationId, scopeFor(ownerId), { limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
  });

  it('shows another customer nothing at all', async () => {
    const stranger = await seedUser(prisma);
    const page = await rsvps.listInScope(invitationId, scopeFor(stranger), {
      limit: 50,
      offset: 0,
    });
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('shows platform staff nothing either', async () => {
    // The acceptance criterion in full: guest data is the one category staff
    // may not read, and the repository has no staff branch to grant it.
    const admin = await seedUser(prisma, { role: 'admin' });
    const staffActor: Actor = {
      kind: 'user',
      userId: admin,
      role: 'admin',
      emailVerified: true,
      status: 'active',
      sessionId: 's',
      memberships: [],
    };
    const scope = tenantScopeFor(staffActor);
    expect(scope).not.toBeNull();
    if (!scope) return;

    const page = await rsvps.listInScope(invitationId, scope, { limit: 50, offset: 0 });
    expect(page.rows).toEqual([]);
    expect(await rsvps.statsInScope(invitationId, scope)).toBeNull();
    expect(await rsvps.allInScope(invitationId, scope, 100)).toEqual([]);
  });

  it('never returns a credential with a row', async () => {
    const page = await rsvps.listInScope(invitationId, scopeFor(ownerId), { limit: 50, offset: 0 });
    const row = page.rows[0] as unknown as Record<string, unknown>;
    expect(row['dedupeHash']).toBeUndefined();
    expect(row['editTokenHash']).toBeUndefined();
  });
});

describe('searching and filtering (D7.5)', () => {
  beforeEach(async () => {
    await rsvps.submit(command({ name: 'خالد العتيبي', phone: '0501111111', partySize: 2 }));
    await rsvps.submit(command({ name: 'سارة', attending: false, partySize: 0 }));
    await rsvps.submit(command({ name: 'محمد', partySize: 4 }));
  });

  it('filters to those attending', async () => {
    const page = await rsvps.listInScope(invitationId, scopeFor(ownerId), {
      attending: true,
      limit: 50,
      offset: 0,
    });
    expect(page.total).toBe(2);
  });

  it('finds a guest by part of their name', async () => {
    const page = await rsvps.listInScope(invitationId, scopeFor(ownerId), {
      query: 'العتيبي',
      limit: 50,
      offset: 0,
    });
    expect(page.rows.map((row) => row.name)).toEqual(['خالد العتيبي']);
  });

  it('finds a guest by their phone number', async () => {
    const page = await rsvps.listInScope(invitationId, scopeFor(ownerId), {
      query: '0501111111',
      limit: 50,
      offset: 0,
    });
    expect(page.rows).toHaveLength(1);
  });

  it('reports the total independently of the page', async () => {
    const page = await rsvps.listInScope(invitationId, scopeFor(ownerId), { limit: 1, offset: 0 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('computes stats from the rows, not from the cached counters', async () => {
    const stats = await rsvps.statsInScope(invitationId, scopeFor(ownerId));
    expect(stats).toEqual({ responses: 3, attending: 2, declined: 1, guests: 6 });
  });
});

// ── deletion ────────────────────────────────────────────────────────────────

describe('removing a reply', () => {
  it('deletes the row and corrects the counters', async () => {
    const submitted = await rsvps.submit(command({ name: 'خالد', partySize: 3 }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    expect(
      await rsvps.deleteInScope(submitted.rsvpId, invitationId, scopeFor(ownerId), new Date()),
    ).toBe(true);

    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(0);
    expect(await counters()).toEqual({ rsvpYesCount: 0, rsvpNoCount: 0, rsvpGuestCount: 0 });
  });

  it('refuses another tenant’s reply', async () => {
    const submitted = await rsvps.submit(command({ name: 'خالد' }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const stranger = await seedUser(prisma);
    expect(
      await rsvps.deleteInScope(submitted.rsvpId, invitationId, scopeFor(stranger), new Date()),
    ).toBe(false);
    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(1);
  });
});

// ── the invitation relationship ─────────────────────────────────────────────

describe('replies and the invitation they belong to', () => {
  it('cannot be attached to another invitation by id alone', async () => {
    // The dedupe hash includes the invitation, so a reply crafted for one
    // wedding cannot silently merge into another's list.
    const otherOwner = await seedUser(prisma);
    const other = await seedInvitation(prisma, { ownerId: otherOwner, templateVersionId });

    await rsvps.submit(command({ name: 'خالد' }));
    await rsvps.submit(command({ name: 'خالد', invitation: other }));

    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(1);
    expect(await prisma.rsvp.count({ where: { invitationId: other } })).toBe(1);
  });

  it('is removed with the invitation, leaving nothing behind', async () => {
    await rsvps.submit(command({ name: 'خالد' }));
    const snapshot = createSnapshot(snapshotFixture());
    expect(snapshot.ok).toBe(true);

    await prisma.invitation.delete({ where: { id: invitationId } });
    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(0);
  });

  it('leaves the published snapshot untouched', async () => {
    // Replies are live data; the snapshot is immutable (ADR-0005). A guest
    // replying must not alter what other guests are reading.
    const snapshot = createSnapshot(snapshotFixture());
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    await invitations.publish(
      {
        invitationId,
        slug: 'rsvp-snapshot',
        snapshot: snapshot.snapshot,
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(ownerId),
    );

    const before = await invitations.findPublishedBySlug('rsvp-snapshot');
    await rsvps.submit(command({ name: 'خالد', partySize: 2 }));
    const after = await invitations.findPublishedBySlug('rsvp-snapshot');

    expect(JSON.stringify(after?.snapshot)).toBe(JSON.stringify(before?.snapshot));
  });
});
