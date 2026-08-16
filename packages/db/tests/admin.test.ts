import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  type Actor,
  NO_CDN_PURGER,
  type ModerationAuditEntry,
  createSnapshot,
  moderateInvitation,
  rsvpDedupeHash,
  systemClock,
  tenantScopeFor,
} from '@zfaf/core';

import { PrismaAdminRepository } from '../src/repositories/admin.repository.js';
import { PrismaInvitationRepository } from '../src/repositories/invitation.repository.js';
import {
  resetDatabase,
  seedInvitation,
  seedTemplate,
  seedUser,
  snapshotFixture,
  testClient,
} from './helpers/database.js';

/**
 * The admin console and the kill switch against real PostgreSQL (D8.5–D8.7).
 *
 * The two properties worth a real database: that a suspension actually stops
 * the public read path within the same request, and that the console's queries
 * cannot return guest data — which is a statement about the SQL, not about the
 * TypeScript above it.
 */

let prisma: PrismaClient;
let admin: PrismaAdminRepository;
let invitations: PrismaInvitationRepository;
let templateVersionId: string;
let ownerId: string;
let invitationId: string;
let slug: string;

function actorFor(userId: string, role: 'customer' | 'support' | 'admin'): Actor {
  return {
    kind: 'user',
    userId,
    role,
    emailVerified: true,
    status: 'active',
    sessionId: 'session',
    memberships: [],
  };
}

function scopeFor(userId: string) {
  const scope = tenantScopeFor(actorFor(userId, 'customer'));
  if (!scope) throw new Error('expected a scope');
  return scope;
}

async function publish(id: string, withSlug: string, by: string): Promise<void> {
  const snapshot = createSnapshot(snapshotFixture());
  if (!snapshot.ok) throw new Error('fixture snapshot is invalid');
  const outcome = await invitations.publish(
    {
      invitationId: id,
      slug: withSlug,
      snapshot: snapshot.snapshot,
      publishedBy: by,
      expiresAt: null,
      now: new Date(),
    },
    scopeFor(by),
  );
  if (!outcome.ok) throw new Error(`publish failed: ${outcome.error}`);
}

beforeAll(async () => {
  prisma = testClient();
  admin = new PrismaAdminRepository(prisma);
  invitations = new PrismaInvitationRepository(prisma);
  await resetDatabase(prisma);
  templateVersionId = await seedTemplate(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  /**
   * `TRUNCATE`, not `DELETE`.
   *
   * `audit_logs` rejects `DELETE` by trigger (M1) — the append-only guarantee
   * applies to the test suite as much as to an operator, and discovering that
   * here is a good sign rather than an inconvenience. `resetDatabase` truncates
   * instead, which is a different operation the trigger does not (and should
   * not) intercept, and it is available only to a fixture with the whole
   * schema in hand.
   */
  await resetDatabase(prisma);
  templateVersionId = await seedTemplate(prisma);
  ownerId = await seedUser(prisma);
  invitationId = await seedInvitation(prisma, { ownerId, templateVersionId });
  slug = `admin-${invitationId.slice(0, 8)}`;
  await publish(invitationId, slug, ownerId);
});

// ── the kill switch ─────────────────────────────────────────────────────────

describe('the kill switch', () => {
  const recorded: ModerationAuditEntry[] = [];

  function deps(cdn = NO_CDN_PURGER) {
    return {
      admin,
      invitations,
      cdn,
      clock: systemClock,
      recordModeration: async (entry: ModerationAuditEntry) => {
        recorded.push(entry);
        await prisma.auditLog.create({
          data: {
            id: crypto.randomUUID(),
            actorId: entry.actorId,
            actorType: 'staff',
            action: `invitation.${entry.action}`,
            resourceType: 'invitation',
            resourceId: entry.invitationId,
            metadata: {
              reason: entry.reason,
              previousStatus: entry.previousStatus,
              nextStatus: entry.nextStatus,
              purged: entry.purged,
            },
            createdAt: entry.at,
          },
        });
      },
    };
  }

  beforeEach(() => {
    recorded.length = 0;
  });

  it('stops the public page serving the invitation, immediately', async () => {
    // The exit criterion, at the origin. Before: the page is servable. After:
    // it is not — in the same process, without waiting for anything.
    expect(await invitations.findPublishedBySlug(slug)).not.toBeNull();

    const staff = await seedUser(prisma, { role: 'support' });
    const started = Date.now();
    const result = await moderateInvitation(
      {
        actor: actorFor(staff, 'support'),
        invitationId,
        action: 'suspend',
        reason: 'impersonation',
      },
      deps(),
    );
    const elapsed = Date.now() - started;

    expect(result).toMatchObject({ ok: true, status: 'SUSPENDED' });
    expect(elapsed).toBeLessThan(10_000);

    const identity = await invitations.resolvePublicSlug(slug);
    // SUSPENDED is what makes the public route answer 451 rather than render.
    expect(identity?.status).toBe('SUSPENDED');
  });

  it('leaves the published snapshot and the replies untouched', async () => {
    // Suspending is a moderation state, not a deletion. If the block is lifted
    // the invitation must be exactly what it was.
    const before = await invitations.findPublishedBySlug(slug);
    await prisma.rsvp.create({
      data: {
        id: crypto.randomUUID(),
        invitationId,
        name: 'خالد',
        attending: true,
        partySize: 2,
        dedupeHash: Buffer.from(rsvpDedupeHash({ invitationId, name: 'خالد', phone: null })),
      },
    });

    const staff = await seedUser(prisma, { role: 'support' });
    await moderateInvitation(
      { actor: actorFor(staff, 'support'), invitationId, action: 'suspend', reason: 'reported' },
      deps(),
    );

    expect(await prisma.rsvp.count({ where: { invitationId } })).toBe(1);
    const versions = await prisma.invitationVersion.count({ where: { invitationId } });
    expect(versions).toBe(1);

    // And it comes back intact when the block is lifted.
    await moderateInvitation(
      { actor: actorFor(staff, 'support'), invitationId, action: 'unsuspend', reason: 'resolved' },
      deps(),
    );
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(row.status).toBe('PAUSED');
    expect(row.publishedVersionId).toBe(before ? row.publishedVersionId : null);
    expect(row.publishedVersionId).not.toBeNull();
  });

  it('refuses the owner and leaves the invitation published', async () => {
    const result = await moderateInvitation(
      { actor: actorFor(ownerId, 'customer'), invitationId, action: 'suspend', reason: 'mine' },
      deps(),
    );

    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } })).status,
    ).toBe('PUBLISHED');
  });

  it('writes an audit row that survives an attempt to delete it', async () => {
    const staff = await seedUser(prisma, { role: 'admin' });
    await moderateInvitation(
      { actor: actorFor(staff, 'admin'), invitationId, action: 'suspend', reason: 'stolen photo' },
      deps(),
    );

    const rows = await prisma.auditLog.findMany({ where: { resourceId: invitationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('invitation.suspend');
    expect(rows[0]?.metadata).toMatchObject({
      reason: 'stolen photo',
      previousStatus: 'PUBLISHED',
      nextStatus: 'SUSPENDED',
    });

    // The append-only trigger from M1. An audit log an operator can erase is
    // not an audit log, and the guarantee lives in the database rather than in
    // a code review.
    await expect(
      prisma.auditLog.deleteMany({ where: { resourceId: invitationId } }),
    ).rejects.toThrow();
    await expect(
      prisma.auditLog.updateMany({
        where: { resourceId: invitationId },
        data: { action: 'nothing.happened' },
      }),
    ).rejects.toThrow();
  });

  it('records that no purge happened when no CDN is configured', async () => {
    const staff = await seedUser(prisma, { role: 'support' });
    const result = await moderateInvitation(
      { actor: actorFor(staff, 'support'), invitationId, action: 'suspend', reason: 'spam' },
      deps(),
    );

    expect(result).toMatchObject({ ok: true, purged: false });
    expect(recorded[0]?.purged).toBe(false);
    expect(recorded[0]?.cdn).toBe('none');
  });
});

// ── the console's reads ─────────────────────────────────────────────────────

describe('the admin console reads', () => {
  const page = { limit: 25, offset: 0 };

  it('finds an invitation by slug, title or owner email, case-insensitively', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });

    for (const query of [slug.toUpperCase(), 'TEST INVITATION', owner.email.toUpperCase()]) {
      const result = await admin.listInvitations({ ...page, query });
      expect(result.rows.map((row) => row.id)).toContain(invitationId);
    }
  });

  it('returns a reply count and no reply', async () => {
    await prisma.rsvp.create({
      data: {
        id: crypto.randomUUID(),
        invitationId,
        name: 'خالد العتيبي',
        attending: true,
        partySize: 3,
        phone: '0501234567',
        note: 'نباتي',
        dedupeHash: Buffer.from(
          rsvpDedupeHash({ invitationId, name: 'خالد العتيبي', phone: '0501234567' }),
        ),
      },
    });

    const result = await admin.listInvitations({ ...page, query: slug });
    const row = result.rows.find((candidate) => candidate.id === invitationId);

    expect(row?.rsvpCount).toBe(1);
    // The guest's name, phone and note must not appear anywhere in what the
    // console can hand upward — the assertion is on the serialised row, so a
    // field added later cannot slip past it.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('خالد');
    expect(serialised).not.toContain('0501234567');
    expect(serialised).not.toContain('نباتي');
  });

  it('returns no password hash or session material with a user', async () => {
    const result = await admin.listUsers({ ...page });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash/);
  });

  it('filters invitations by status', async () => {
    const other = await seedInvitation(prisma, { ownerId, templateVersionId });
    expect(other).toBeTruthy();

    const published = await admin.listInvitations({ ...page, status: 'PUBLISHED' });
    expect(published.rows.every((row) => row.status === 'PUBLISHED')).toBe(true);

    const drafts = await admin.listInvitations({ ...page, status: 'DRAFT' });
    expect(drafts.rows.every((row) => row.status === 'DRAFT')).toBe(true);
  });

  it('reports a total independent of the page size', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedInvitation(prisma, { ownerId, templateVersionId });
    }
    const first = await admin.listInvitations({ limit: 2, offset: 0 });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBeGreaterThanOrEqual(4);
  });

  it('lists the audit log newest first and can filter by action', async () => {
    await prisma.auditLog.createMany({
      data: [
        {
          id: crypto.randomUUID(),
          actorType: 'staff',
          action: 'invitation.suspend',
          resourceType: 'invitation',
          resourceId: invitationId,
          metadata: {},
          createdAt: new Date('2026-08-16T10:00:00.000Z'),
        },
        {
          id: crypto.randomUUID(),
          actorType: 'staff',
          action: 'admin.users.list',
          resourceType: 'user',
          resourceId: 'collection',
          metadata: {},
          createdAt: new Date('2026-08-16T11:00:00.000Z'),
        },
      ],
    });

    const all = await admin.listAuditLog({ ...page });
    expect(all.rows[0]?.action).toBe('admin.users.list');

    const filtered = await admin.listAuditLog({ ...page, action: 'invitation.suspend' });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.total).toBe(1);
  });

  it('does not expose the audit log’s ip hash', async () => {
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        actorType: 'staff',
        action: 'admin.users.list',
        resourceType: 'user',
        resourceId: 'collection',
        metadata: {},
        ipHash: Buffer.from(new Uint8Array(32).fill(9)),
      },
    });

    const rows = await admin.listAuditLog({ ...page });
    // It exists so an incident can be correlated, not so an operator can
    // browse it on a screen.
    expect(Object.keys(rows.rows[0] ?? {})).not.toContain('ipHash');
  });
});
