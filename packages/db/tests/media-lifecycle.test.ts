import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  type Actor,
  type PublishedSnapshot,
  createSnapshot,
  deleteMedia,
  sweepMedia,
  systemClock,
  tenantScopeFor,
} from '@zfaf/core';
import { InMemoryStorageProvider } from '@zfaf/infra';

import { PrismaInvitationRepository } from '../src/repositories/invitation.repository.js';
import {
  PrismaMediaMaintenanceRepository,
  PrismaMediaRepository,
} from '../src/repositories/media.repository.js';
import {
  resetDatabase,
  seedInvitation,
  seedTemplate,
  seedUser,
  snapshotFixture,
  testClient,
} from './helpers/database.js';

/**
 * Media lifecycle against a real PostgreSQL (D4.7, D4.8).
 *
 * The deletion guard is the reason this suite exists. Its whole value is that
 * it holds against a snapshot that was really published — a unit test with a
 * stubbed `usage()` proves the branch is reachable, not that the query finds
 * the reference. So this publishes a genuine invitation version whose content
 * names a genuine media row, then attempts the delete.
 */

let prisma: PrismaClient;
let media: PrismaMediaRepository;
let invitations: PrismaInvitationRepository;
let templateVersionId: string;
let ownerId: string;
let otherOwnerId: string;
let invitationId: string;

function scopeFor(userId: string, invitationIds: string[] = []) {
  const actor: Actor = {
    kind: 'user',
    userId,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 's',
    memberships: invitationIds.map((id) => ({ invitationId: id, role: 'owner' as const })),
  };
  const scope = tenantScopeFor(actor);
  if (!scope) throw new Error('expected a scope');
  return scope;
}

function actorFor(userId: string, invitationIds: string[] = []): Actor {
  return {
    kind: 'user',
    userId,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 's',
    memberships: invitationIds.map((id) => ({ invitationId: id, role: 'owner' as const })),
  };
}

async function seedMedia(
  input: { id?: string; owner?: string; invitation?: string | null; sizeBytes?: number } = {},
): Promise<string> {
  const id = input.id ?? randomUUID();
  const owner = input.owner ?? ownerId;
  const invitation = input.invitation === undefined ? invitationId : input.invitation;

  await media.create(scopeFor(owner, invitation ? [invitation] : []), {
    id,
    ownerId: owner,
    invitationId: invitation,
    purpose: 'gallery',
    storageKey: `media/${owner}/${invitation ?? 'library'}/${id}/original.bin` as never,
    originalFilename: 'photo.jpg',
    declaredMimeType: 'image/jpeg',
    declaredSizeBytes: input.sizeBytes ?? 1_000_000,
    signedMaxBytes: 8 * 1024 * 1024,
  });

  return id;
}

/** Publishes a snapshot whose gallery names the given media ids. */
async function publishReferencing(mediaIds: readonly string[]): Promise<void> {
  const content = {
    ...(snapshotFixture()['content'] as Record<string, unknown>),
    gallery: mediaIds.map((id) => ({
      id,
      url: `https://cdn.zfaf.app/${id}.avif`,
      width: 800,
      height: 800,
      blurhash: null,
      alt: null,
    })),
  };

  const built = createSnapshot(snapshotFixture({ content }));
  if (!built.ok) throw new Error(`fixture invalid: ${JSON.stringify(built.errors)}`);

  const outcome = await invitations.publish(
    {
      invitationId,
      slug: `test-${Date.now().toString(36)}`,
      snapshot: built.snapshot as PublishedSnapshot,
      publishedBy: ownerId,
      expiresAt: null,
      now: new Date(),
    },
    scopeFor(ownerId, [invitationId]),
  );
  if (!outcome.ok) throw new Error(`publish failed: ${JSON.stringify(outcome)}`);
}

beforeAll(async () => {
  prisma = testClient();
  media = new PrismaMediaRepository(prisma);
  invitations = new PrismaInvitationRepository(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  templateVersionId = await seedTemplate(prisma);
  ownerId = await seedUser(prisma, 'owner@zfaf.test');
  otherOwnerId = await seedUser(prisma, 'other@zfaf.test');
  invitationId = await seedInvitation(prisma, { ownerId, templateVersionId });
});

// ── D4.7 ───────────────────────────────────────────────────────────────────

describe('media used by a published invitation', () => {
  it('cannot be deleted', async () => {
    // The scenario in full: an owner tidies their library three weeks after
    // sending the link, and three hundred guests find a broken image.
    const mediaId = await seedMedia();
    await publishReferencing([mediaId]);

    const result = await deleteMedia(
      { actor: actorFor(ownerId, [invitationId]), mediaId },
      { repository: media, clock: systemClock },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('USED_IN_PUBLISHED_INVITATION');

    const row = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    expect(row?.deletedAt).toBeNull();
  });

  it('names the version that blocks the delete', async () => {
    const mediaId = await seedMedia();
    await publishReferencing([mediaId]);

    const usage = await media.usage(scopeFor(ownerId, [invitationId]), mediaId);
    expect(usage.publishedVersionIds).toHaveLength(1);

    const version = await prisma.invitationVersion.findUnique({
      where: { id: usage.publishedVersionIds[0] as string },
    });
    expect(version?.invitationId).toBe(invitationId);
  });

  it('does not block an unrelated asset owned by the same person', async () => {
    // A guard against an over-broad query: blocking everything would be an
    // easy way to pass the test above and a terrible product.
    const referenced = await seedMedia();
    const unrelated = await seedMedia();
    await publishReferencing([referenced]);

    const result = await deleteMedia(
      { actor: actorFor(ownerId, [invitationId]), mediaId: unrelated },
      { repository: media, clock: systemClock },
    );

    expect(result.ok).toBe(true);
    const row = await prisma.mediaAsset.findUnique({ where: { id: unrelated } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('becomes deletable once the invitation is unpublished', async () => {
    // Unpublishing keeps the last version row — that is how republishing works
    // — so the guard has to key on visibility rather than on the row existing,
    // or an owner could never tidy a library after unpublishing.
    const mediaId = await seedMedia();
    await publishReferencing([mediaId]);

    const moved = await invitations.transitionStatus(
      invitationId,
      scopeFor(ownerId, [invitationId]),
      'DRAFT',
      new Date(),
    );
    expect(moved).toBe(true);

    const result = await deleteMedia(
      { actor: actorFor(ownerId, [invitationId]), mediaId },
      { repository: media, clock: systemClock },
    );
    expect(result.ok).toBe(true);
  });

  it('finds a reference in the cover and the couple photo, not only the gallery', async () => {
    const cover = await seedMedia();
    const photo = await seedMedia();

    const base = snapshotFixture()['content'] as Record<string, unknown>;
    const built = createSnapshot(
      snapshotFixture({
        content: {
          ...base,
          cover: {
            id: cover,
            url: 'https://cdn.zfaf.app/cover.avif',
            width: 1920,
            height: 1080,
            blurhash: null,
            alt: null,
          },
          couple: {
            ...(base['couple'] as Record<string, unknown>),
            photo: {
              id: photo,
              url: 'https://cdn.zfaf.app/couple.avif',
              width: 800,
              height: 800,
              blurhash: null,
              alt: null,
            },
          },
        },
      }),
    );
    if (!built.ok) throw new Error('fixture invalid');

    const outcome = await invitations.publish(
      {
        invitationId,
        slug: 'cover-and-photo',
        snapshot: built.snapshot as PublishedSnapshot,
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(ownerId, [invitationId]),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    for (const mediaId of [cover, photo]) {
      const result = await deleteMedia(
        { actor: actorFor(ownerId, [invitationId]), mediaId },
        { repository: media, clock: systemClock },
      );
      expect(result.ok, `${mediaId} was deletable`).toBe(false);
    }
  });
});

// ── tenant scoping ─────────────────────────────────────────────────────────

describe('tenant scoping on media', () => {
  it('does not return another owner’s asset', async () => {
    const theirs = await seedMedia({ owner: otherOwnerId, invitation: null });
    expect(await media.findById(scopeFor(ownerId), theirs)).toBeNull();
  });

  it('refuses to create a row for an owner outside the scope', async () => {
    await expect(
      media.create(scopeFor(ownerId), {
        id: randomUUID(),
        ownerId: otherOwnerId,
        invitationId: null,
        purpose: 'gallery',
        storageKey: 'media/x/library/y/original.bin' as never,
        originalFilename: 'photo.jpg',
        declaredMimeType: 'image/jpeg',
        declaredSizeBytes: 1000,
        signedMaxBytes: 1000,
      }),
    ).rejects.toThrow(/outside the request scope/);
  });

  it('does not count another owner’s bytes against this owner’s quota', async () => {
    await seedMedia({ sizeBytes: 2_000_000 });
    await seedMedia({ owner: otherOwnerId, invitation: null, sizeBytes: 90_000_000 });

    expect(await media.storageUsedBytes(scopeFor(ownerId, [invitationId]))).toBe(2_000_000);
  });

  it('counts pending uploads against the quota', async () => {
    // Excluding them is how an owner exceeds their quota by never confirming.
    const mediaId = await seedMedia({ sizeBytes: 3_000_000 });
    const row = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    expect(row?.status).toBe('pending');
    expect(await media.storageUsedBytes(scopeFor(ownerId, [invitationId]))).toBe(3_000_000);
  });

  it('stops counting a failed upload', async () => {
    const mediaId = await seedMedia({ sizeBytes: 3_000_000 });
    await prisma.mediaAsset.update({ where: { id: mediaId }, data: { status: 'failed' } });
    expect(await media.storageUsedBytes(scopeFor(ownerId, [invitationId]))).toBe(0);
  });
});

// ── D4.8 ───────────────────────────────────────────────────────────────────

describe('the sweep', () => {
  it('removes an upload abandoned more than a day ago, and its object', async () => {
    const mediaId = await seedMedia();
    const key = (await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } })).storageKey;
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
    });

    const storage = new InMemoryStorageProvider();
    storage.seed(key as never, new Uint8Array([1, 2, 3]), 'image/jpeg');

    const report = await sweepMedia({
      repository: new PrismaMediaMaintenanceRepository(prisma),
      storage,
      clock: systemClock,
    });

    expect(report.stalePendingRemoved).toBe(1);
    expect(report.failures).toEqual([]);
    expect(await prisma.mediaAsset.findUnique({ where: { id: mediaId } })).toBeNull();
    expect(storage.keys()).toEqual([]);
  });

  it('leaves a recent pending upload alone', async () => {
    // A slow upload on a poor connection must not be mistaken for an
    // abandoned one.
    const mediaId = await seedMedia();

    const report = await sweepMedia({
      repository: new PrismaMediaMaintenanceRepository(prisma),
      storage: new InMemoryStorageProvider(),
      clock: systemClock,
    });

    expect(report.stalePendingRemoved).toBe(0);
    expect(await prisma.mediaAsset.findUnique({ where: { id: mediaId } })).not.toBeNull();
  });

  it('purges a soft-deleted asset only after the grace period', async () => {
    const recent = await seedMedia();
    const old = await seedMedia();

    await prisma.mediaAsset.update({
      where: { id: recent },
      data: { status: 'ready', deletedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    await prisma.mediaAsset.update({
      where: { id: old },
      data: { status: 'ready', deletedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });

    const report = await sweepMedia({
      repository: new PrismaMediaMaintenanceRepository(prisma),
      storage: new InMemoryStorageProvider(),
      clock: systemClock,
    });

    expect(report.purgedAssets).toBe(1);
    expect(await prisma.mediaAsset.findUnique({ where: { id: recent } })).not.toBeNull();
    expect(await prisma.mediaAsset.findUnique({ where: { id: old } })).toBeNull();
  });

  it('removes every derivative, not just the original', async () => {
    const mediaId = await seedMedia();
    const key = (await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } })).storageKey;
    const prefix = key.slice(0, key.lastIndexOf('/') + 1);

    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { status: 'ready', deletedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });

    const storage = new InMemoryStorageProvider();
    for (const name of ['original.bin', 'w400.avif', 'w1080.avif', 'w1920.jpg']) {
      storage.seed(`${prefix}${name}` as never, new Uint8Array([1]), 'image/avif');
    }

    const report = await sweepMedia({
      repository: new PrismaMediaMaintenanceRepository(prisma),
      storage,
      clock: systemClock,
    });

    expect(report.storageObjectsDeleted).toBe(4);
    expect(storage.keys()).toEqual([]);
  });
});
