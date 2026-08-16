import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { type Actor, type PublishedSnapshot, createSnapshot, tenantScopeFor } from '@zfaf/core';
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
 * Race conditions, resolved in the database rather than the client.
 *
 * The scenarios here are not hypothetical: two people publishing at the same
 * moment, a double-tapped submit on a slow phone, two browser tabs editing one
 * invitation. Each is handled by a constraint or a predicate in the statement
 * itself, because a check-then-write in application code loses these races.
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

function fixtureSnapshot(): PublishedSnapshot {
  const result = createSnapshot(snapshotFixture());
  if (!result.ok) throw new Error('fixture is invalid');
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

describe('simultaneous publish of the same slug', () => {
  it('lets exactly one succeed', async () => {
    const userA = await seedUser(prisma);
    const userB = await seedUser(prisma);
    const invitationA = await seedInvitation(prisma, { ownerId: userA, templateVersionId });
    const invitationB = await seedInvitation(prisma, { ownerId: userB, templateVersionId });

    const now = new Date();
    const [resultA, resultB] = await Promise.all([
      repository.publish(
        {
          invitationId: invitationA,
          slug: 'ahmad-sarah',
          snapshot: fixtureSnapshot(),
          publishedBy: userA,
          expiresAt: null,
          now,
        },
        scopeFor(userA),
      ),
      repository.publish(
        {
          invitationId: invitationB,
          slug: 'ahmad-sarah',
          snapshot: fixtureSnapshot(),
          publishedBy: userB,
          expiresAt: null,
          now,
        },
        scopeFor(userB),
      ),
    ]);

    const succeeded = [resultA, resultB].filter((result) => result.ok);
    const failed = [resultA, resultB].filter((result) => !result.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.ok === false && failed[0].error).toBe('SLUG_TAKEN');

    // And exactly one row holds the slug.
    const holders = await prisma.invitation.count({
      where: { slug: 'ahmad-sarah', deletedAt: null },
    });
    expect(holders).toBe(1);
  });

  it('holds under higher contention', async () => {
    const contenders = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const userId = await seedUser(prisma);
        const invitationId = await seedInvitation(prisma, { ownerId: userId, templateVersionId });
        return { userId, invitationId };
      }),
    );

    const now = new Date();
    const results = await Promise.all(
      contenders.map((contender) =>
        repository.publish(
          {
            invitationId: contender.invitationId,
            slug: 'popular-slug',
            snapshot: fixtureSnapshot(),
            publishedBy: contender.userId,
            expiresAt: null,
            now,
          },
          scopeFor(contender.userId),
        ),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await prisma.invitation.count({ where: { slug: 'popular-slug', deletedAt: null } }),
    ).toBe(1);
  });
});

describe('slug reuse after deletion', () => {
  it('frees the slug for another invitation once deleted', async () => {
    const userA = await seedUser(prisma);
    const userB = await seedUser(prisma);
    const invitationA = await seedInvitation(prisma, { ownerId: userA, templateVersionId });
    const invitationB = await seedInvitation(prisma, { ownerId: userB, templateVersionId });

    const first = await repository.publish(
      {
        invitationId: invitationA,
        slug: 'shared-name',
        snapshot: fixtureSnapshot(),
        publishedBy: userA,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userA),
    );
    expect(first.ok).toBe(true);

    // Blocked while the first invitation is live — this is the partial index
    // doing its job.
    const blocked = await repository.publish(
      {
        invitationId: invitationB,
        slug: 'shared-name',
        snapshot: fixtureSnapshot(),
        publishedBy: userB,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userB),
    );
    expect(blocked.ok).toBe(false);

    await repository.softDelete(invitationA, scopeFor(userA), new Date());

    const afterDelete = await repository.publish(
      {
        invitationId: invitationB,
        slug: 'shared-name',
        snapshot: fixtureSnapshot(),
        publishedBy: userB,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(userB),
    );
    expect(afterDelete.ok).toBe(true);
  });
});

describe('simultaneous draft updates', () => {
  it('lets one win and reports a conflict to the other', async () => {
    const userId = await seedUser(prisma);
    const invitationId = await seedInvitation(prisma, { ownerId: userId, templateVersionId });
    const scope = scopeFor(userId);
    const now = new Date();

    // Two tabs, both holding draft version 1.
    const [first, second] = await Promise.all([
      repository.updateDraft(invitationId, scope, { schemaVersion: 1, from: 'tab-a' }, 1, now),
      repository.updateDraft(invitationId, scope, { schemaVersion: 1, from: 'tab-b' }, 1, now),
    ]);

    const succeeded = [first, second].filter((result) => result.ok);
    expect(succeeded).toHaveLength(1);

    const conflicted = [first, second].find((result) => !result.ok);
    expect(conflicted?.ok === false && conflicted.error).toBe('VERSION_CONFLICT');

    const record = await repository.findByIdInScope(invitationId, scope);
    expect(record?.draftVersion).toBe(2);
  });

  it('accepts a sequential update once the caller re-reads the version', async () => {
    const userId = await seedUser(prisma);
    const invitationId = await seedInvitation(prisma, { ownerId: userId, templateVersionId });
    const scope = scopeFor(userId);

    const first = await repository.updateDraft(invitationId, scope, { v: 1 }, 1, new Date());
    expect(first.ok && first.draftVersion).toBe(2);

    const second = await repository.updateDraft(invitationId, scope, { v: 2 }, 2, new Date());
    expect(second.ok && second.draftVersion).toBe(3);

    const stale = await repository.updateDraft(invitationId, scope, { v: 3 }, 1, new Date());
    expect(stale.ok).toBe(false);
  });
});

describe('repeated publishes of one invitation', () => {
  it('produces strictly increasing version numbers with no gaps or duplicates', async () => {
    const userId = await seedUser(prisma);
    const invitationId = await seedInvitation(prisma, { ownerId: userId, templateVersionId });
    const scope = scopeFor(userId);

    for (let index = 0; index < 4; index += 1) {
      const result = await repository.publish(
        {
          invitationId,
          slug: 'ahmad-sarah',
          snapshot: fixtureSnapshot(),
          publishedBy: userId,
          expiresAt: null,
          now: new Date(),
        },
        scope,
      );
      expect(result.ok && result.versionNumber).toBe(index + 1);
    }

    const versions = await prisma.invitationVersion.findMany({
      where: { invitationId },
      select: { versionNumber: true },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3, 4]);
  });
});

describe('renaming a slug preserves the old link', () => {
  it('records the previous slug so links already sent still resolve', async () => {
    const userId = await seedUser(prisma);
    const invitationId = await seedInvitation(prisma, { ownerId: userId, templateVersionId });
    const scope = scopeFor(userId);

    await repository.publish(
      {
        invitationId,
        slug: 'old-name',
        snapshot: fixtureSnapshot(),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(),
      },
      scope,
    );
    await repository.publish(
      {
        invitationId,
        slug: 'new-name',
        snapshot: fixtureSnapshot(),
        publishedBy: userId,
        expiresAt: null,
        now: new Date(),
      },
      scope,
    );

    // The old link is already in hundreds of WhatsApp threads and cannot be
    // recalled, so it must keep resolving (ADR-0013).
    expect(await repository.findSlugRedirect('old-name')).toBe('new-name');
    expect(await repository.findPublishedBySlug('new-name')).not.toBeNull();
  });
});
