import { describe, expect, it } from 'vitest';

import { type Actor, type UserRole, anonymous } from '../../authz/actor.js';
import type { InvitationRecord, InvitationRepository } from '../ports/invitation-repository.js';
import type { MediaRepository } from '../../media/ports/media-repository.js';
import { deleteInvitation } from './delete-invitation.js';
import { systemClock } from '../../ports/clock.js';

const NOW = new Date('2026-08-17T09:00:00.000Z');

function actor(userId: string, role: UserRole): Actor {
  return {
    kind: 'user',
    userId,
    role,
    emailVerified: true,
    status: 'active',
    sessionId: `session-${userId}`,
    memberships: [],
  };
}

function invitation(overrides: Record<string, unknown> = {}): InvitationRecord {
  return {
    id: 'inv-1',
    ownerId: 'user-1',
    slug: 'test-invitation',
    title: 'Test Invitation',
    templateKey: 'classic-luxury',
    templateVersionId: 'tv-1',
    locale: 'en',
    marketCode: 'US',
    timezone: 'UTC',
    eventDate: '2026-12-01',
    eventStartTime: null,
    status: 'DRAFT',
    draftDocument: { template: 'classic-luxury' },
    draftVersion: 1,
    publishedVersionId: null,
    visibility: 'UNLISTED',
    expiresAt: null,
    publishedAt: null,
    createdAt: new Date('2026-08-10T00:00:00Z'),
    updatedAt: new Date('2026-08-10T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

function harness(options: { existing?: InvitationRecord | null } = {}) {
  const inv = options.existing ?? invitation();
  const repository = {
    softDelete: async (id: string) => {
      if (id === inv.id) return true;
      return false;
    },
  } as unknown as InvitationRepository;

  const media = {
    orphanByInvitation: async () => {
      // no-op for testing
    },
  } as unknown as MediaRepository;

  return {
    repository,
    media,
    inv,
  };
}

describe('deleteInvitation', () => {
  it('deletes an invitation owned by the actor', async () => {
    const owner = actor('user-1', 'customer');
    const inv = invitation({ ownerId: 'user-1' });
    const { repository, media } = harness({ existing: inv });

    const result = await deleteInvitation(
      {
        actor: owner,
        invitationId: inv.id,
        invitationOwnerId: inv.ownerId,
      },
      {
        repository,
        media,
        clock: systemClock,
      },
    );

    expect(result.ok).toBe(true);
  });

  it('rejects deletion by non-owner', async () => {
    const notOwner = actor('user-2', 'customer');
    const inv = invitation({ ownerId: 'user-1' });
    const { repository, media } = harness({ existing: inv });

    const result = await deleteInvitation(
      {
        actor: notOwner,
        invitationId: inv.id,
        invitationOwnerId: inv.ownerId,
      },
      {
        repository,
        media,
        clock: systemClock,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['NOT_A_MEMBER', 'INSUFFICIENT_MEMBERSHIP_ROLE']).toContain(result.code);
    }
  });

  it('rejects deletion by anonymous user', async () => {
    const anon = anonymous('ip-hash');
    const inv = invitation({ ownerId: 'user-1' });
    const { repository, media } = harness({ existing: inv });

    const result = await deleteInvitation(
      {
        actor: anon,
        invitationId: inv.id,
        invitationOwnerId: inv.ownerId,
      },
      {
        repository,
        media,
        clock: systemClock,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ANONYMOUS');
    }
  });

  it('reports not found when invitation does not exist', async () => {
    const owner = actor('user-1', 'customer');
    const { repository, media } = harness({ existing: null });

    const result = await deleteInvitation(
      {
        actor: owner,
        invitationId: 'nonexistent',
        invitationOwnerId: 'user-1',
      },
      {
        repository,
        media,
        clock: systemClock,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });
});
