import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  type Actor,
  type PublishedSnapshot,
  createSnapshot,
  tenantScopeFor,
  verifySnapshotChecksum,
} from '@zfaf/core';
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
 * Publication against real PostgreSQL (D6.1–D6.3).
 *
 * Everything here depends on behaviour that has no meaningful mock: the
 * immutability trigger on `invitation_versions`, the partial unique index on
 * `slug`, the check constraint tying a published invitation to a version, and
 * what a `WHERE` predicate actually matches under concurrent writes. A fake
 * would report success for precisely the cases most likely to be wrong.
 */

let prisma: PrismaClient;
let repository: PrismaInvitationRepository;
let templateVersionId: string;

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

function snapshot(overrides: Record<string, unknown> = {}): PublishedSnapshot {
  const result = createSnapshot(snapshotFixture(overrides));
  if (!result.ok) throw new Error(`fixture is invalid: ${JSON.stringify(result.errors)}`);
  return result.snapshot;
}

beforeAll(() => {
  prisma = testClient();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  repository = new PrismaInvitationRepository(prisma);
  templateVersionId = await seedTemplate(prisma);
});

async function publishOnce(slug: string, overrides: Record<string, unknown> = {}) {
  const userId = await seedUser(prisma);
  const invitationId = await seedInvitation(prisma, { ownerId: userId, templateVersionId });
  const result = await repository.publish(
    {
      invitationId,
      slug,
      snapshot: snapshot(overrides),
      publishedBy: userId,
      expiresAt: null,
      now: new Date(),
    },
    scopeFor(userId),
  );
  if (!result.ok) throw new Error(`publish failed: ${result.error}`);
  return { userId, invitationId, ...result };
}

// ── the published snapshot ──────────────────────────────────────────────────

describe('the published snapshot', () => {
  it('is served to anyone holding the slug, with no scope', async () => {
    const { invitationId } = await publishOnce('ahmad-sara');

    const view = await repository.findPublishedBySlug('ahmad-sara');
    expect(view?.invitationId).toBe(invitationId);
    expect(view?.status).toBe('PUBLISHED');
    expect(view?.snapshot.content.couple.groomName).toBeTruthy();
  });

  it('does not change when the draft is edited afterwards (ADR-0005)', async () => {
    // The nightmare this prevents: an owner fixing a typo while 200 guests are
    // looking at a half-edited invitation.
    const { invitationId, userId } = await publishOnce('frozen-one');
    const before = await repository.findPublishedBySlug('frozen-one');

    await repository.updateDraft(
      invitationId,
      scopeFor(userId),
      { schemaVersion: 1, edited: 'after publishing' },
      1,
      new Date(),
    );

    const after = await repository.findPublishedBySlug('frozen-one');
    expect(JSON.stringify(after?.snapshot)).toBe(JSON.stringify(before?.snapshot));
  });

  it('carries a checksum that verifies against what was stored', async () => {
    const { invitationId } = await publishOnce('checksummed');

    const version = await prisma.invitationVersion.findFirstOrThrow({
      where: { invitationId },
      select: { publishedDocument: true, documentChecksum: true },
    });

    expect(verifySnapshotChecksum(version.publishedDocument, version.documentChecksum)).toBe(
      'MATCH',
    );
  });

  it('detects a snapshot altered outside the application', async () => {
    // The immutability trigger blocks UPDATE, so tampering has to arrive some
    // other way — a doctored backup, a migration that rewrites JSONB. The
    // checksum is what makes that *detectable* rather than merely disallowed.
    const { invitationId } = await publishOnce('tampered');
    const version = await prisma.invitationVersion.findFirstOrThrow({
      where: { invitationId },
      select: { publishedDocument: true, documentChecksum: true },
    });

    const doctored = structuredClone(version.publishedDocument) as Record<string, never>;
    (doctored as Record<string, unknown>)['templateKey'] = 'someone-elses-template';

    expect(verifySnapshotChecksum(doctored, version.documentChecksum)).toBe('MISMATCH');
  });

  it('refuses to be updated, whatever the caller intends', async () => {
    const { invitationId } = await publishOnce('immutable');
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE invitation_versions SET document_checksum = 'x' WHERE invitation_id = $1::uuid`,
        invitationId,
      ),
    ).rejects.toThrow(/immutable/i);
  });
});

// ── republishing and rollback (D6.3) ────────────────────────────────────────

describe('republishing', () => {
  it('appends a version rather than replacing one', async () => {
    const { invitationId, userId } = await publishOnce('appended');

    await repository.publish(
      {
        invitationId,
        slug: 'appended',
        snapshot: snapshot({ locale: 'en' }),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userId),
    );

    const versions = await repository.listVersions(invitationId, scopeFor(userId));
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.versionNumber).sort()).toEqual([1, 2]);
  });

  it('keeps the original publication date across republishes', async () => {
    // `publishedAt` records when the invitation first went live. Overwriting it
    // on every save would make "published 3 minutes ago" true forever.
    const { invitationId, userId } = await publishOnce('dated');
    const first = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { publishedAt: true },
    });

    await repository.publish(
      {
        invitationId,
        slug: 'dated',
        snapshot: snapshot({ locale: 'en' }),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(Date.now() + 60_000),
      },
      scopeFor(userId),
    );

    const second = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { publishedAt: true },
    });
    expect(second.publishedAt?.getTime()).toBe(first.publishedAt?.getTime());
  });
});

describe('rollback', () => {
  it('serves the earlier version afterwards', async () => {
    const { invitationId, userId } = await publishOnce('rolled', { locale: 'ar' });
    await repository.publish(
      {
        invitationId,
        slug: 'rolled',
        snapshot: snapshot({ locale: 'en' }),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userId),
    );

    expect((await repository.findPublishedBySlug('rolled'))?.snapshot.locale).toBe('en');

    const outcome = await repository.rollbackToVersion(
      invitationId,
      scopeFor(userId),
      1,
      new Date(),
    );
    expect(outcome.ok).toBe(true);
    expect((await repository.findPublishedBySlug('rolled'))?.snapshot.locale).toBe('ar');
  });

  it('leaves both versions in place, so rolling back is itself reversible', async () => {
    const { invitationId, userId } = await publishOnce('reversible');
    await repository.publish(
      {
        invitationId,
        slug: 'reversible',
        snapshot: snapshot({ locale: 'en' }),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userId),
    );

    await repository.rollbackToVersion(invitationId, scopeFor(userId), 1, new Date());
    expect(await prisma.invitationVersion.count({ where: { invitationId } })).toBe(2);

    const forward = await repository.rollbackToVersion(
      invitationId,
      scopeFor(userId),
      2,
      new Date(),
    );
    expect(forward.ok).toBe(true);
    expect((await repository.findPublishedBySlug('reversible'))?.snapshot.locale).toBe('en');
  });

  it('refuses a version that does not exist', async () => {
    const { invitationId, userId } = await publishOnce('no-such');
    const outcome = await repository.rollbackToVersion(
      invitationId,
      scopeFor(userId),
      9,
      new Date(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('NO_SUCH_VERSION');
  });

  it('refuses another tenant’s invitation', async () => {
    const { invitationId } = await publishOnce('not-yours');
    const stranger = await seedUser(prisma);

    const outcome = await repository.rollbackToVersion(
      invitationId,
      scopeFor(stranger),
      1,
      new Date(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('NOT_FOUND');
  });
});

// ── slugs (D6.1) ────────────────────────────────────────────────────────────

describe('slugs', () => {
  it('keeps the old one resolvable after a rename', async () => {
    const { invitationId, userId } = await publishOnce('first-name');
    await repository.publish(
      {
        invitationId,
        slug: 'second-name',
        snapshot: snapshot(),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userId),
    );

    await expect(repository.findSlugRedirect('first-name')).resolves.toBe('second-name');
    expect(await repository.findPublishedBySlug('first-name')).toBeNull();
    expect(await repository.findPublishedBySlug('second-name')).not.toBeNull();
  });

  it('treats a retired slug as unavailable', async () => {
    // Handing it to someone else would silently repoint a link that is still in
    // other people's messages at a stranger's wedding.
    const { invitationId, userId } = await publishOnce('retired-name');
    await repository.publish(
      {
        invitationId,
        slug: 'current-name',
        snapshot: snapshot(),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userId),
    );

    await expect(repository.isSlugAvailable('retired-name')).resolves.toBe(false);
    await expect(repository.isSlugAvailable('current-name')).resolves.toBe(false);
    await expect(repository.isSlugAvailable('nobody-has-this')).resolves.toBe(true);
  });

  it('is case-insensitive, so one name cannot become two invitations', async () => {
    await publishOnce('mixed-case');
    await expect(repository.isSlugAvailable('MIXED-CASE')).resolves.toBe(false);
    expect(await repository.findPublishedBySlug('Mixed-Case')).not.toBeNull();
  });

  it('releases the slug when the invitation is deleted', async () => {
    const { invitationId, userId } = await publishOnce('released');
    await repository.softDelete(invitationId, scopeFor(userId), new Date());
    await expect(repository.isSlugAvailable('released')).resolves.toBe(true);
  });
});

// ── expiry and visibility ───────────────────────────────────────────────────

describe('the expiry sweep (D6.3)', () => {
  it('expires what has passed and leaves the rest alone', async () => {
    const past = await publishOnce('gone-already');
    const future = await publishOnce('still-coming');

    await prisma.invitation.update({
      where: { id: past.invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.invitation.update({
      where: { id: future.invitationId },
      data: { expiresAt: new Date(Date.now() + 86_400_000) },
    });

    const expired = await repository.expireDueInvitations(new Date(), 100);
    expect(expired).toEqual([past.invitationId]);

    const rows = await prisma.invitation.findMany({
      where: { id: { in: [past.invitationId, future.invitationId] } },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    });
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    expect(byId.get(past.invitationId)).toBe('EXPIRED');
    expect(byId.get(future.invitationId)).toBe('PUBLISHED');
  });

  it('never touches an invitation with no expiry set', async () => {
    const forever = await publishOnce('no-expiry');
    await repository.expireDueInvitations(new Date(), 100);

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: forever.invitationId },
      select: { status: true },
    });
    expect(row.status).toBe('PUBLISHED');
  });

  it('is bounded, so a backlog cannot become one enormous transaction', async () => {
    for (let index = 0; index < 4; index += 1) {
      const seeded = await publishOnce(`backlog-${index}`);
      await prisma.invitation.update({
        where: { id: seeded.invitationId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    }

    expect(await repository.expireDueInvitations(new Date(), 2)).toHaveLength(2);
    expect(await repository.expireDueInvitations(new Date(), 2)).toHaveLength(2);
    expect(await repository.expireDueInvitations(new Date(), 2)).toHaveLength(0);
  });
});

describe('visibility (ADR-0017)', () => {
  it('starts unlisted, which is not the same as private', async () => {
    const { invitationId } = await publishOnce('default-visibility');
    const view = await repository.findPublishedBySlug('default-visibility');
    expect(view?.visibility).toBe('UNLISTED');
    expect(view?.invitationId).toBe(invitationId);
  });

  it('can be made indexable, and back', async () => {
    const { invitationId, userId } = await publishOnce('indexable');

    expect(
      await repository.setVisibility(invitationId, scopeFor(userId), 'INDEXED', new Date()),
    ).toBe(true);
    expect((await repository.findPublishedBySlug('indexable'))?.visibility).toBe('INDEXED');

    await repository.setVisibility(invitationId, scopeFor(userId), 'UNLISTED', new Date());
    expect((await repository.findPublishedBySlug('indexable'))?.visibility).toBe('UNLISTED');
  });

  it('cannot be changed by another tenant', async () => {
    const { invitationId } = await publishOnce('not-theirs');
    const stranger = await seedUser(prisma);
    expect(
      await repository.setVisibility(invitationId, scopeFor(stranger), 'INDEXED', new Date()),
    ).toBe(false);
  });
});
