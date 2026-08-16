import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { type PublishedSnapshot, createSnapshot, tenantScopeFor, type Actor } from '@zfaf/core';
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
 * Published-snapshot immutability, enforced by the database (ADR-0005).
 *
 * The domain returns deeply frozen objects and exposes no update method, but
 * neither survives contact with raw SQL. These tests bypass the domain entirely
 * and issue direct statements — the only way to prove the invariant actually
 * holds rather than merely being observed by well-behaved code.
 */

let prisma: PrismaClient;
let repository: PrismaInvitationRepository;
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

function fixtureSnapshot(overrides: Record<string, unknown> = {}): PublishedSnapshot {
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
  ownerId = await seedUser(prisma);
  invitationId = await seedInvitation(prisma, { ownerId, templateVersionId });
});

describe('the database rejects mutation of a published snapshot', () => {
  it('refuses a direct UPDATE', async () => {
    const published = await repository.publish(
      {
        invitationId,
        slug: 'ahmad-sarah',
        snapshot: fixtureSnapshot(),
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(ownerId),
    );
    expect(published.ok).toBe(true);

    // Bypasses every application-level guard on purpose.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE invitation_versions SET published_document = '{"tampered":true}'::jsonb WHERE invitation_id = $1::uuid`,
        invitationId,
      ),
    ).rejects.toThrow(/immutable/i);

    // The snapshot guests hold is unchanged.
    const view = await repository.findPublishedBySlug('ahmad-sarah');
    expect(view?.snapshot.content.couple.groomName).toBe('أحمد');
  });

  it('refuses a DELETE while the invitation still exists', async () => {
    await repository.publish(
      {
        invitationId,
        slug: 'ahmad-sarah',
        snapshot: fixtureSnapshot(),
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(ownerId),
    );

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM invitation_versions WHERE invitation_id = $1::uuid`,
        invitationId,
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('still permits the cascade when the invitation itself is removed', async () => {
    // Account deletion and retention must keep working; the trigger blocks
    // targeted tampering, not lawful cleanup.
    await repository.publish(
      {
        invitationId,
        slug: 'ahmad-sarah',
        snapshot: fixtureSnapshot(),
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(ownerId),
    );

    // Note: clearing published_version_id alone would violate
    // invitations_published_requires_version — the constraint keeps status and
    // pointer consistent. Removing the invitation outright is the real path.
    await prisma.$executeRawUnsafe(`DELETE FROM invitations WHERE id = $1::uuid`, invitationId);

    const remaining = await prisma.invitationVersion.count({ where: { invitationId } });
    expect(remaining).toBe(0);
  });

  it('refuses mutation of the audit log too', async () => {
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        actorType: 'user',
        action: 'invitation.published',
        resourceType: 'invitation',
        resourceId: invitationId,
      },
    });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`),
    ).rejects.toThrow(/append-only/i);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(
      /append-only/i,
    );
  });
});

describe('editing a draft never touches the published snapshot', () => {
  it('leaves the public view unchanged until republished', async () => {
    await repository.publish(
      {
        invitationId,
        slug: 'ahmad-sarah',
        snapshot: fixtureSnapshot(),
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(ownerId),
    );

    const before = await repository.findPublishedBySlug('ahmad-sarah');
    expect(before?.snapshot.content.couple.groomName).toBe('أحمد');

    // The owner edits the draft — the scenario where 200 guests would otherwise
    // see a half-finished invitation.
    const updated = await repository.updateDraft(
      invitationId,
      scopeFor(ownerId),
      { schemaVersion: 1, content: { couple: { groomName: 'DRAFT EDIT' } } },
      1,
      new Date(),
    );
    expect(updated.ok).toBe(true);

    const after = await repository.findPublishedBySlug('ahmad-sarah');
    expect(after?.snapshot.content.couple.groomName).toBe('أحمد');
    expect(after?.versionNumber).toBe(1);
  });

  it('publishing again creates a new version rather than updating the old one', async () => {
    const scope = scopeFor(ownerId);
    const first = await repository.publish(
      {
        invitationId,
        slug: 'ahmad-sarah',
        snapshot: fixtureSnapshot(),
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scope,
    );
    expect(first.ok && first.versionNumber).toBe(1);

    const second = await repository.publish(
      {
        invitationId,
        slug: 'ahmad-sarah',
        snapshot: fixtureSnapshot({
          content: {
            ...(snapshotFixture()['content'] as Record<string, unknown>),
            couple: {
              groomName: 'أحمد الجديد',
              brideName: 'سارة',
              shortName: null,
              message: null,
              photo: null,
            },
          },
        }),
        publishedBy: ownerId,
        expiresAt: null,
        now: new Date(),
      },
      scope,
    );
    expect(second.ok && second.versionNumber).toBe(2);

    // Both versions exist; version 1 is untouched and still retrievable.
    const versions = await repository.listVersions(invitationId, scope);
    expect(versions).toHaveLength(2);

    const original = await repository.getVersionSnapshot(invitationId, 1, scope);
    expect(original?.content.couple.groomName).toBe('أحمد');

    const current = await repository.findPublishedBySlug('ahmad-sarah');
    expect(current?.snapshot.content.couple.groomName).toBe('أحمد الجديد');
    expect(current?.versionNumber).toBe(2);
  });
});

describe('a published invitation must point at a snapshot', () => {
  it('rejects a PUBLISHED row with no published version', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE invitations SET status = 'PUBLISHED' WHERE id = $1::uuid`,
        invitationId,
      ),
    ).rejects.toThrow(/invitations_published_requires_version/);
  });
});
