import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../../authz/actor.js';
import type { Clock } from '../../ports/clock.js';
import type { TenantScope } from '../../authz/tenant-scope.js';
import type { InvitationStatus } from '../domain/invitation-status.js';
import type { PublishedSnapshot } from '../domain/published-snapshot.js';
import type {
  CreateInvitationInput,
  InvitationRecord,
  InvitationRepository,
  InvitationSummary,
  PublicInvitationView,
  PublicSlugIdentity,
  PublishInput,
  PublishOutcome,
  RollbackOutcome,
  UpdateDraftOutcome,
} from '../ports/invitation-repository.js';
import { type PublishAuditEntry, publishInvitation } from './publish-invitation.js';
import {
  expireDueInvitations,
  rollbackInvitation,
  unpublishInvitation,
} from './manage-publication.js';
import { validDraftInput } from '../../testing/draft-fixture.js';

/**
 * Publishing, against an in-memory repository.
 *
 * The fake enforces the two things the real one enforces — a unique slug and
 * an append-only version list — because those are what the use case leans on.
 * Everything else about publishing is decided here, in the use case, and that
 * is what these tests exercise. The database's own guarantees are proven
 * separately against real PostgreSQL in the integration suite; asserting them
 * twice against a fake would only prove the fake.
 */

const OWNER = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const INVITATION = 'b0000000-0000-4000-8000-000000000001';

function owner(): Actor {
  return {
    kind: 'user',
    userId: OWNER,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 'session-1',
    memberships: [{ invitationId: INVITATION, role: 'owner' }],
  };
}

function stranger(): Actor {
  return {
    kind: 'user',
    userId: OTHER,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 'session-2',
    memberships: [],
  };
}

function viewer(): Actor {
  return {
    kind: 'user',
    userId: OTHER,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 'session-3',
    memberships: [{ invitationId: INVITATION, role: 'viewer' }],
  };
}

class FakeInvitationRepository implements InvitationRepository {
  readonly rows = new Map<string, InvitationRecord>();
  readonly versions = new Map<string, { versionNumber: number; snapshot: PublishedSnapshot }[]>();
  readonly redirects = new Map<string, string>();
  private counter = 0;

  seed(record: InvitationRecord): void {
    this.rows.set(record.id, record);
  }

  private get(id: string, scope: TenantScope): InvitationRecord | null {
    const row = this.rows.get(id);
    if (!row || row.deletedAt !== null) return null;
    if (scope.isPlatformStaff) return row;
    if (scope.ownerId === row.ownerId) return row;
    return scope.invitationIds.includes(row.id) ? row : null;
  }

  async findByIdInScope(id: string, scope: TenantScope): Promise<InvitationRecord | null> {
    return this.get(id, scope);
  }

  async listInScope(): Promise<readonly InvitationSummary[]> {
    return [];
  }

  async countActiveInScope(): Promise<number> {
    return this.rows.size;
  }

  async findPublishedBySlug(slug: string): Promise<PublicInvitationView | null> {
    for (const row of this.rows.values()) {
      if (row.slug !== slug || row.publishedVersionId === null) continue;
      const history = this.versions.get(row.id) ?? [];
      const current = history.at(-1);
      if (!current) return null;
      return {
        invitationId: row.id,
        status: row.status,
        visibility: row.visibility,
        snapshot: current.snapshot,
        versionNumber: current.versionNumber,
        expiresAt: row.expiresAt,
      };
    }
    return null;
  }

  async findSlugRedirect(oldSlug: string): Promise<string | null> {
    return this.redirects.get(oldSlug) ?? null;
  }

  async resolvePublicSlug(slug: string): Promise<PublicSlugIdentity | null> {
    for (const row of this.rows.values()) {
      if (row.slug === slug && row.deletedAt === null) {
        return { invitationId: row.id, status: row.status, expiresAt: row.expiresAt };
      }
    }
    return null;
  }

  async isSlugAvailable(slug: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.slug === slug && row.deletedAt === null) return false;
    }
    return !this.redirects.has(slug);
  }

  async create(input: CreateInvitationInput): Promise<InvitationRecord> {
    throw new Error(`not needed by these tests: ${input.id}`);
  }

  async updateDraft(): Promise<UpdateDraftOutcome> {
    return { ok: false, error: 'NOT_FOUND' };
  }

  async publish(input: PublishInput, scope: TenantScope): Promise<PublishOutcome> {
    const row = this.get(input.invitationId, scope);
    if (!row) return { ok: false, error: 'NOT_FOUND' };

    // The unique index, in miniature: another live invitation already at that
    // address makes this publish lose, whatever order the calls arrived in.
    for (const other of this.rows.values()) {
      if (other.id !== row.id && other.slug === input.slug && other.deletedAt === null) {
        return { ok: false, error: 'SLUG_TAKEN' };
      }
    }

    const history = this.versions.get(row.id) ?? [];
    const versionNumber = history.length + 1;
    this.counter += 1;
    const versionId = `version-${this.counter}`;
    history.push({ versionNumber, snapshot: input.snapshot });
    this.versions.set(row.id, history);

    if (row.slug !== null && row.slug !== input.slug) this.redirects.set(row.slug, input.slug);

    this.rows.set(row.id, {
      ...row,
      slug: input.slug,
      status: 'PUBLISHED',
      publishedVersionId: versionId,
      publishedAt: row.publishedAt ?? input.now,
      expiresAt: input.expiresAt,
    });

    return { ok: true, versionId, versionNumber };
  }

  async transitionStatus(id: string, scope: TenantScope, next: InvitationStatus): Promise<boolean> {
    const row = this.get(id, scope);
    if (!row) return false;
    this.rows.set(id, { ...row, status: next });
    return true;
  }

  async setVisibility(
    id: string,
    scope: TenantScope,
    visibility: 'UNLISTED' | 'INDEXED',
  ): Promise<boolean> {
    const row = this.get(id, scope);
    if (!row) return false;
    this.rows.set(id, { ...row, visibility });
    return true;
  }

  async softDelete(): Promise<boolean> {
    return false;
  }

  async listVersions(id: string, scope: TenantScope) {
    if (!this.get(id, scope)) return [];
    return (this.versions.get(id) ?? []).map((version) => ({
      versionId: `version-${version.versionNumber}`,
      versionNumber: version.versionNumber,
      publishedAt: new Date(0),
    }));
  }

  async getVersionSnapshot(id: string, versionNumber: number, scope: TenantScope) {
    if (!this.get(id, scope)) return null;
    return (
      (this.versions.get(id) ?? []).find((v) => v.versionNumber === versionNumber)?.snapshot ?? null
    );
  }

  async rollbackToVersion(
    id: string,
    scope: TenantScope,
    versionNumber: number,
  ): Promise<RollbackOutcome> {
    const row = this.get(id, scope);
    if (!row) return { ok: false, error: 'NOT_FOUND' };
    if (row.publishedVersionId === null) return { ok: false, error: 'NOT_PUBLISHED' };
    const target = (this.versions.get(id) ?? []).find((v) => v.versionNumber === versionNumber);
    if (!target) return { ok: false, error: 'NO_SUCH_VERSION' };
    this.rows.set(id, { ...row, publishedVersionId: `version-${versionNumber}` });
    return { ok: true, versionId: `version-${versionNumber}`, versionNumber };
  }

  async expireDueInvitations(now: Date, limit: number): Promise<readonly string[]> {
    const expired: string[] = [];
    for (const row of this.rows.values()) {
      if (expired.length >= limit) break;
      if (row.status !== 'PUBLISHED') continue;
      if (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()) continue;
      this.rows.set(row.id, { ...row, status: 'EXPIRED' });
      expired.push(row.id);
    }
    return expired;
  }
}

const NOW = new Date('2026-08-16T10:00:00.000Z');
const clock: Clock = { now: () => NOW };

let repository: FakeInvitationRepository;
let audit: PublishAuditEntry[];

function deps() {
  return {
    repository,
    clock,
    recordPublication: async (entry: PublishAuditEntry) => {
      audit.push(entry);
    },
  };
}

function record(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    id: INVITATION,
    ownerId: OWNER,
    slug: null,
    title: 'دعوة',
    status: 'DRAFT',
    templateKey: 'classic-luxury',
    templateVersionId: 'tv-1',
    locale: 'ar',
    marketCode: 'SA',
    timezone: 'Asia/Riyadh',
    eventDate: '2026-09-20',
    eventStartTime: '20:00',
    draftDocument: validDraftInput(),
    draftVersion: 3,
    publishedVersionId: null,
    visibility: 'UNLISTED',
    expiresAt: null,
    publishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  repository = new FakeInvitationRepository();
  audit = [];
});

describe('publishInvitation', () => {
  it('publishes and derives a slug from the couple’s names', async () => {
    repository.seed(record());

    const result = await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe('ahmd-sarh');
    expect(result.versionNumber).toBe(1);
    expect(result.firstPublication).toBe(true);
  });

  it('records the publication in the audit trail', async () => {
    repository.seed(record());
    await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'publish', actorId: OWNER, versionNumber: 1 });
  });

  it('refuses a stranger', async () => {
    repository.seed(record());
    const result = await publishInvitation({ actor: stranger(), invitationId: INVITATION }, deps());
    // Not found rather than forbidden: the scope never reached the row, so the
    // use case cannot distinguish "yours and refused" from "not yours".
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['NOT_FOUND', 'FORBIDDEN']).toContain(result.code);
  });

  it('refuses a viewer, who may read but not publish', async () => {
    repository.seed(record());
    const result = await publishInvitation({ actor: viewer(), invitationId: INVITATION }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FORBIDDEN');
  });

  it('refuses to publish an invitation moderation has suspended', async () => {
    // The owner must not be able to lift a moderation action on themselves.
    repository.seed(record({ status: 'SUSPENDED' }));
    const result = await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses an unfinished invitation and says what is missing', async () => {
    repository.seed(record({ draftDocument: validDraftInput({ groomName: '' }) }));
    const result = await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'NOT_READY') {
      expect(result.issues.map((issue) => issue.field)).toContain('content.couple.groomName');
    } else {
      expect.unreachable('expected NOT_READY');
    }
  });

  it('refuses a reserved slug', async () => {
    repository.seed(record());
    const result = await publishInvitation(
      { actor: owner(), invitationId: INVITATION, slug: 'admin' },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'INVALID_SLUG') expect(result.issue).toBe('RESERVED');
    else expect.unreachable('expected INVALID_SLUG');
  });

  it('lets only one of two invitations hold a slug', async () => {
    repository.seed(record());
    repository.seed(
      record({
        id: 'b0000000-0000-4000-8000-000000000002',
        slug: 'ahmad-sara',
        status: 'PUBLISHED',
      }),
    );

    const result = await publishInvitation(
      { actor: owner(), invitationId: INVITATION, slug: 'ahmad-sara' },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SLUG_TAKEN');
  });

  it('keeps the existing slug when the owner does not ask to change it', async () => {
    // The old link is already in people's messages; a silent rename would
    // break it for everyone who has it.
    repository.seed(record({ slug: 'our-wedding', status: 'PUBLISHED', publishedVersionId: 'v0' }));
    const result = await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slug).toBe('our-wedding');
  });

  it('keeps the old slug resolvable after a rename', async () => {
    repository.seed(record({ slug: 'our-wedding', status: 'PUBLISHED', publishedVersionId: 'v0' }));
    await publishInvitation(
      { actor: owner(), invitationId: INVITATION, slug: 'ahmad-and-sara' },
      deps(),
    );
    await expect(repository.findSlugRedirect('our-wedding')).resolves.toBe('ahmad-and-sara');
  });

  it('appends a version rather than replacing one', async () => {
    repository.seed(record());
    await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    const second = await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.versionNumber).toBe(2);
    expect(second.firstPublication).toBe(false);
    expect(repository.versions.get(INVITATION)).toHaveLength(2);
  });

  it('publishes only what the draft holds, not a placeholder', async () => {
    repository.seed(record());
    await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    const snapshot = repository.versions.get(INVITATION)?.[0]?.snapshot;
    expect(snapshot?.content.couple.groomName).toBe('أحمد');
  });
});

describe('unpublishInvitation', () => {
  it('pauses a published invitation', async () => {
    repository.seed(record({ status: 'PUBLISHED', slug: 'x-y', publishedVersionId: 'v1' }));
    const result = await unpublishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    expect(result.ok).toBe(true);
    expect(repository.rows.get(INVITATION)?.status).toBe('PAUSED');
  });

  it('refuses to unpublish something that was never published', async () => {
    repository.seed(record());
    const result = await unpublishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('rollbackInvitation', () => {
  beforeEach(async () => {
    repository.seed(record());
    await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
    await publishInvitation({ actor: owner(), invitationId: INVITATION }, deps());
  });

  it('points the invitation back at an earlier version', async () => {
    const result = await rollbackInvitation(
      { actor: owner(), invitationId: INVITATION, versionNumber: 1 },
      deps(),
    );
    expect(result.ok).toBe(true);
    expect(repository.rows.get(INVITATION)?.publishedVersionId).toBe('version-1');
  });

  it('leaves the version it rolled away from in place', async () => {
    // Rolling back is itself reversible; that is what makes it safe to offer.
    await rollbackInvitation(
      { actor: owner(), invitationId: INVITATION, versionNumber: 1 },
      deps(),
    );
    expect(repository.versions.get(INVITATION)).toHaveLength(2);
  });

  it('refuses a version that does not exist', async () => {
    const result = await rollbackInvitation(
      { actor: owner(), invitationId: INVITATION, versionNumber: 99 },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_SUCH_VERSION');
  });

  it('requires the permission to publish, because it changes what guests see', async () => {
    const result = await rollbackInvitation(
      { actor: viewer(), invitationId: INVITATION, versionNumber: 1 },
      deps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FORBIDDEN');
  });
});

describe('expireDueInvitations', () => {
  it('expires what has passed and leaves what has not', async () => {
    repository.seed(
      record({
        id: 'b0000000-0000-4000-8000-000000000003',
        status: 'PUBLISHED',
        expiresAt: new Date(NOW.getTime() - 1),
      }),
    );
    repository.seed(
      record({
        id: 'b0000000-0000-4000-8000-000000000004',
        status: 'PUBLISHED',
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      }),
    );

    const result = await expireDueInvitations(deps());

    expect(result.expired).toBe(1);
    expect(repository.rows.get('b0000000-0000-4000-8000-000000000003')?.status).toBe('EXPIRED');
    expect(repository.rows.get('b0000000-0000-4000-8000-000000000004')?.status).toBe('PUBLISHED');
  });

  it('is bounded, so a backlog cannot become one enormous transaction', async () => {
    for (let index = 0; index < 5; index += 1) {
      repository.seed(
        record({
          id: `b0000000-0000-4000-8000-00000000001${index}`,
          status: 'PUBLISHED',
          expiresAt: new Date(NOW.getTime() - 1),
        }),
      );
    }
    const result = await expireDueInvitations(deps(), 2);
    expect(result.expired).toBe(2);
  });
});
