import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  type Actor,
  type PublishedSnapshot,
  createSnapshot,
  systemScope,
  tenantScopeFor,
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
 * Tenant isolation, verified against a real database.
 *
 * The premise is deliberately hostile: tenant B holds a *valid* id belonging to
 * tenant A. This is exactly the situation an IDOR exploit is in, and the point
 * of the design is that knowing the id is not enough — the scope predicate is
 * part of the query, not a check a caller might forget.
 */

let prisma: PrismaClient;
let repository: PrismaInvitationRepository;

let templateVersionId: string;
let tenantA: string;
let tenantB: string;
let invitationA: string;

function actorFor(
  userId: string,
  role: 'customer' | 'support' | 'admin' | 'superadmin' = 'customer',
): Actor {
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

function scopeFor(
  userId: string,
  role: 'customer' | 'support' | 'admin' | 'superadmin' = 'customer',
) {
  const scope = tenantScopeFor(actorFor(userId, role));
  if (!scope) throw new Error('expected a scope');
  return scope;
}

function fixtureSnapshot(): PublishedSnapshot {
  const result = createSnapshot(snapshotFixture());
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
  tenantA = await seedUser(prisma);
  tenantB = await seedUser(prisma);
  invitationA = await seedInvitation(prisma, { ownerId: tenantA, templateVersionId });
});

describe('reads across tenants', () => {
  it('tenant A can read their own invitation', async () => {
    const found = await repository.findByIdInScope(invitationA, scopeFor(tenantA));
    expect(found).not.toBeNull();
    expect(found?.ownerId).toBe(tenantA);
  });

  it("tenant B cannot read tenant A's invitation, even holding a valid id", async () => {
    const found = await repository.findByIdInScope(invitationA, scopeFor(tenantB));
    expect(found).toBeNull();
  });

  it("tenant B's listing does not include tenant A's invitations", async () => {
    const list = await repository.listInScope(scopeFor(tenantB));
    expect(list).toHaveLength(0);

    const ownList = await repository.listInScope(scopeFor(tenantA));
    expect(ownList).toHaveLength(1);
  });

  it("tenant B's active count does not include tenant A's invitations", async () => {
    expect(await repository.countActiveInScope(scopeFor(tenantB))).toBe(0);
    expect(await repository.countActiveInScope(scopeFor(tenantA))).toBe(1);
  });

  it("tenant B cannot read tenant A's version history", async () => {
    expect(await repository.listVersions(invitationA, scopeFor(tenantB))).toHaveLength(0);
  });
});

describe('writes across tenants', () => {
  it("tenant B cannot update tenant A's draft", async () => {
    const result = await repository.updateDraft(
      invitationA,
      scopeFor(tenantB),
      { schemaVersion: 1, hacked: true },
      1,
      new Date(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('NOT_FOUND');

    // And the row is untouched.
    const record = await repository.findByIdInScope(invitationA, scopeFor(tenantA));
    expect(record?.draftVersion).toBe(1);
    expect(record?.draftDocument).toEqual({ schemaVersion: 1 });
  });

  it("tenant B cannot publish tenant A's invitation", async () => {
    const result = await repository.publish(
      {
        invitationId: invitationA,
        slug: 'stolen-slug',
        snapshot: fixtureSnapshot(),
        publishedBy: tenantB,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(tenantB),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('NOT_FOUND');

    const record = await repository.findByIdInScope(invitationA, scopeFor(tenantA));
    expect(record?.status).toBe('DRAFT');
    expect(record?.slug).toBeNull();
  });

  it("tenant B cannot delete tenant A's invitation", async () => {
    expect(await repository.softDelete(invitationA, scopeFor(tenantB), new Date())).toBe(false);

    const record = await repository.findByIdInScope(invitationA, scopeFor(tenantA));
    expect(record?.deletedAt).toBeNull();
  });

  it("tenant B cannot change the status of tenant A's invitation", async () => {
    expect(
      await repository.transitionStatus(invitationA, scopeFor(tenantB), 'SUSPENDED', new Date()),
    ).toBe(false);

    const record = await repository.findByIdInScope(invitationA, scopeFor(tenantA));
    expect(record?.status).toBe('DRAFT');
  });
});

describe('membership grants access without ownership', () => {
  it('an invited editor can read the invitation they were added to', async () => {
    await prisma.invitationMember.create({
      data: {
        id: randomUUID(),
        invitationId: invitationA,
        userId: tenantB,
        role: 'editor',
        acceptedAt: new Date(),
      },
    });

    const actor: Actor = {
      ...actorFor(tenantB),
      memberships: [{ invitationId: invitationA, role: 'editor' }],
    } as Actor;
    const scope = tenantScopeFor(actor);
    expect(scope).not.toBeNull();
    if (!scope) return;

    const found = await repository.findByIdInScope(invitationA, scope);
    expect(found?.id).toBe(invitationA);
  });

  it('membership grants access to that invitation only', async () => {
    const otherInvitation = await seedInvitation(prisma, {
      ownerId: tenantA,
      templateVersionId,
    });

    const actor: Actor = {
      ...actorFor(tenantB),
      memberships: [{ invitationId: invitationA, role: 'editor' }],
    } as Actor;
    const scope = tenantScopeFor(actor);
    if (!scope) throw new Error('expected a scope');

    expect(await repository.findByIdInScope(invitationA, scope)).not.toBeNull();
    expect(await repository.findByIdInScope(otherInvitation, scope)).toBeNull();
  });
});

describe('staff and system scopes', () => {
  it('staff can read across tenants for moderation', async () => {
    const staff = await seedUser(prisma, { role: 'admin' });
    const found = await repository.findByIdInScope(invitationA, scopeFor(staff, 'admin'));
    expect(found?.id).toBe(invitationA);
  });

  it('a system scope names the job that holds it', async () => {
    const scope = systemScope('retention');
    expect(scope.actorDescription).toBe('system:retention');
    expect(await repository.findByIdInScope(invitationA, scope)).not.toBeNull();
  });

  it('a scope granting nothing matches nothing, rather than matching everything', async () => {
    // The failure mode this guards against: an empty predicate silently
    // widening to "all rows". A user with no invitations must see none, not all.
    const emptyScope = scopeFor(tenantB);
    expect(emptyScope.ownerId).toBe(tenantB);
    expect(await repository.listInScope(emptyScope)).toHaveLength(0);
  });
});

describe('the public read path carries no private data', () => {
  it('returns only publishable fields', async () => {
    await repository.publish(
      {
        invitationId: invitationA,
        slug: 'ahmad-sarah',
        snapshot: fixtureSnapshot(),
        publishedBy: tenantA,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(tenantA),
    );

    const view = await repository.findPublishedBySlug('ahmad-sarah');
    expect(view).not.toBeNull();
    if (!view) return;

    // The type cannot express these fields; this asserts the runtime object
    // matches, so a future change cannot quietly widen the payload.
    expect(Object.keys(view).sort()).toEqual(
      ['expiresAt', 'invitationId', 'snapshot', 'status', 'versionNumber', 'visibility'].sort(),
    );
    expect(JSON.stringify(view)).not.toContain(tenantA);
  });

  it('does not serve an unpublished invitation', async () => {
    expect(await repository.findPublishedBySlug('never-published')).toBeNull();
  });

  it('does not serve a soft-deleted invitation', async () => {
    await repository.publish(
      {
        invitationId: invitationA,
        slug: 'to-be-deleted',
        snapshot: fixtureSnapshot(),
        publishedBy: tenantA,
        expiresAt: null,
        now: new Date(),
      },
      scopeFor(tenantA),
    );
    await repository.softDelete(invitationA, scopeFor(tenantA), new Date());

    expect(await repository.findPublishedBySlug('to-be-deleted')).toBeNull();
  });
});
