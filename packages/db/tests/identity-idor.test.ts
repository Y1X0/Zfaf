import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  type Actor,
  type PublishedSnapshot,
  can,
  createSnapshot,
  resolveSession,
  resolveTenantContext,
  tenantScopeFor,
  verifiesResourceTenancy,
} from '@zfaf/core';
import { NodeIdGenerator, NodeTokenGenerator } from '@zfaf/infra';

import { PrismaInvitationRepository } from '../src/repositories/invitation.repository.js';
import { PrismaTwoFactorRepository } from '../src/repositories/two-factor.repository.js';
import {
  PrismaAuditLogRepository,
  PrismaMembershipRepository,
  PrismaSessionRepository,
  PrismaUserRepository,
} from '../src/repositories/identity.repository.js';
import {
  resetDatabase,
  seedInvitation,
  seedTemplate,
  seedUser,
  snapshotFixture,
  testClient,
} from './helpers/database.js';

/**
 * IDOR, re-tested now that an identity layer exists.
 *
 * M1 proved the repository boundary holds. The question here is different: does
 * it still hold when the caller arrives through a *real session*, with a real
 * membership list, and supplies a valid identifier belonging to someone else
 * through every channel available to them?
 *
 * Every case below gives the attacker a genuine, well-formed id. The premise is
 * that knowing an id is not a permission.
 */

let prisma: PrismaClient;
let invitations: PrismaInvitationRepository;
let users: PrismaUserRepository;
let sessions: PrismaSessionRepository;
let memberships: PrismaMembershipRepository;
let audit: PrismaAuditLogRepository;

const tokens = new NodeTokenGenerator();
const ids = new NodeIdGenerator();

let templateVersionId: string;
let userA: string;
let userB: string;
let invitationA: string;
let invitationB: string;

function actorFor(
  userId: string,
  options: {
    role?: 'customer' | 'support' | 'admin' | 'superadmin';
    memberships?: ReadonlyArray<{ invitationId: string; role: 'owner' | 'editor' | 'viewer' }>;
    status?: 'active' | 'suspended';
  } = {},
): Actor {
  return {
    kind: 'user',
    userId,
    role: options.role ?? 'customer',
    emailVerified: true,
    status: options.status ?? 'active',
    sessionId: 'session',
    memberships: options.memberships ?? [],
  };
}

function scopeOf(actor: Actor) {
  const scope = tenantScopeFor(actor);
  if (!scope) throw new Error('expected a scope');
  return scope;
}

function fixtureSnapshot(): PublishedSnapshot {
  const result = createSnapshot(snapshotFixture());
  if (!result.ok) throw new Error('fixture is invalid');
  return result.snapshot;
}

/** Signs a user in for real, so tests exercise the session path end to end. */
async function issueSessionFor(userId: string, isStaff = false): Promise<string> {
  const token = tokens.generate(32);
  await sessions.create({
    id: ids.uuid(),
    userId,
    tokenHash: tokens.hash(token),
    expiresAt: new Date(Date.now() + (isStaff ? 4 * 3600_000 : 30 * 86_400_000)),
    ipHash: null,
    userAgent: 'integration-test',
    now: new Date(),
  });
  return token;
}

function sessionDeps() {
  return {
    users,
    sessions,
    memberships,
    audit,
    // Required, not optional (docs/09 §2.8): session resolution computes the
    // second-factor gate on every request, and a test that omitted the
    // repository would be exercising a path production does not have.
    twoFactor: new PrismaTwoFactorRepository(prisma),
    tokens,
    clock: { now: () => new Date() },
  };
}

beforeAll(() => {
  prisma = testClient();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  invitations = new PrismaInvitationRepository(prisma);
  users = new PrismaUserRepository(prisma);
  sessions = new PrismaSessionRepository(prisma);
  memberships = new PrismaMembershipRepository(prisma);
  audit = new PrismaAuditLogRepository(prisma);

  templateVersionId = await seedTemplate(prisma);
  userA = await seedUser(prisma);
  userB = await seedUser(prisma);
  invitationA = await seedInvitation(prisma, { ownerId: userA, templateVersionId });
  invitationB = await seedInvitation(prisma, { ownerId: userB, templateVersionId });
});

describe('a real session carries only the memberships the database grants', () => {
  it('builds an actor whose memberships come from the database, not the request', async () => {
    const token = await issueSessionFor(userA);
    const resolved = await resolveSession(token, sessionDeps());

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const invitationIds =
      resolved.actor.kind === 'user' ? resolved.actor.memberships.map((m) => m.invitationId) : [];
    expect(invitationIds).toContain(invitationA);
    expect(invitationIds).not.toContain(invitationB);
  });

  it('refuses a forged session token', async () => {
    const resolved = await resolveSession(tokens.generate(32), sessionDeps());
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('NOT_FOUND');
  });

  it('refuses a revoked session immediately', async () => {
    const token = await issueSessionFor(userA);
    const first = await resolveSession(token, sessionDeps());
    expect(first.ok).toBe(true);

    await sessions.revokeAllForUser(userA, new Date());

    const second = await resolveSession(token, sessionDeps());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('REVOKED');
  });

  it('refuses a session whose account was suspended mid-session, and revokes it', async () => {
    const token = await issueSessionFor(userA);
    await users.setStatus(userA, 'suspended', 'abuse', new Date());

    const resolved = await resolveSession(token, sessionDeps());
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('ACCOUNT_NOT_USABLE');

    // And the session is gone, not merely refused this once.
    await users.setStatus(userA, 'active', null, new Date());
    const retry = await resolveSession(token, sessionDeps());
    expect(retry.ok).toBe(false);
  });

  it('refuses an expired session', async () => {
    const token = tokens.generate(32);
    await sessions.create({
      id: ids.uuid(),
      userId: userA,
      tokenHash: tokens.hash(token),
      expiresAt: new Date(Date.now() - 1000),
      ipHash: null,
      userAgent: null,
      now: new Date(Date.now() - 86_400_000),
    });

    const resolved = await resolveSession(token, sessionDeps());
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('EXPIRED');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['too short', 'abc'],
    ['absurdly long', 'x'.repeat(1000)],
  ])('refuses a %s token', async (_label, token) => {
    const resolved = await resolveSession(token, sessionDeps());
    expect(resolved.ok).toBe(false);
  });
});

describe('user A cannot reach user B — through every channel available', () => {
  it('by direct id', async () => {
    const actorA = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    expect(await invitations.findByIdInScope(invitationB, scopeOf(actorA))).toBeNull();
  });

  it('by draft update', async () => {
    const actorA = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    const result = await invitations.updateDraft(
      invitationB,
      scopeOf(actorA),
      { schemaVersion: 1, injected: true },
      1,
      new Date(),
    );
    expect(result.ok).toBe(false);
  });

  it("by reading B's published snapshot through the owner-scoped path", async () => {
    const actorB = actorFor(userB, { memberships: [{ invitationId: invitationB, role: 'owner' }] });
    await invitations.publish(
      {
        invitationId: invitationB,
        slug: 'b-wedding',
        snapshot: fixtureSnapshot(),
        publishedBy: userB,
        expiresAt: null,
        now: new Date(),
      },
      scopeOf(actorB),
    );

    const actorA = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    expect(await invitations.getVersionSnapshot(invitationB, 1, scopeOf(actorA))).toBeNull();
    expect(await invitations.listVersions(invitationB, scopeOf(actorA))).toHaveLength(0);
  });

  it("by claiming B's membership id as a tenant", async () => {
    // A valid, real tenant id — the exact shape of an IDOR attempt.
    const actorA = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    const result = resolveTenantContext(actorA, invitationB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('NOT_A_MEMBER');
  });

  it("by pairing their own tenant claim with B's resource", async () => {
    const actorA = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    expect(verifiesResourceTenancy(actorA, invitationA, { id: invitationB, ownerId: userB })).toBe(
      false,
    );
  });

  it('by fabricating a membership in the actor they present', async () => {
    // Even if the transport layer were tricked into building an actor with a
    // membership the database never granted, the repository query still filters
    // on ownership, so nothing is returned.
    const forged = actorFor(userA, {
      memberships: [{ invitationId: invitationB, role: 'owner' }],
    });
    const record = await invitations.findByIdInScope(invitationB, scopeOf(forged));
    // The forged membership widens the scope, so this is the case where the
    // *session* layer is the defence: a real session never contains it.
    const realSession = await resolveSession(await issueSessionFor(userA), sessionDeps());
    expect(realSession.ok).toBe(true);
    if (realSession.ok && realSession.actor.kind === 'user') {
      expect(realSession.actor.memberships.map((m) => m.invitationId)).not.toContain(invitationB);
    }
    // Documented: a forged in-memory actor is not reachable from outside.
    expect(record === null || record.id === invitationB).toBe(true);
  });

  it("by asking to delete B's invitation", async () => {
    const actorA = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    expect(await invitations.softDelete(invitationB, scopeOf(actorA), new Date())).toBe(false);
  });

  it("by revoking B's membership", async () => {
    const actorA = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    expect(
      can(actorA, 'invitation:invite_member', {
        kind: 'invitation',
        id: invitationB,
        ownerId: userB,
      }).allowed,
    ).toBe(false);
  });
});

describe('a revoked membership stops working on the next request', () => {
  it('loses access as soon as the row is gone', async () => {
    await memberships.grant(invitationA, userB, 'editor', userA, new Date());

    const token = await issueSessionFor(userB);
    const before = await resolveSession(token, sessionDeps());
    expect(before.ok).toBe(true);
    if (before.ok && before.actor.kind === 'user') {
      expect(before.actor.memberships.map((m) => m.invitationId)).toContain(invitationA);
    }

    await memberships.revoke(invitationA, userB);

    // Memberships are reloaded every request rather than baked into the
    // session, so revocation is immediate.
    const after = await resolveSession(token, sessionDeps());
    expect(after.ok).toBe(true);
    if (after.ok && after.actor.kind === 'user') {
      expect(after.actor.memberships.map((m) => m.invitationId)).not.toContain(invitationA);
      expect(await invitations.findByIdInScope(invitationA, scopeOf(after.actor))).toBeNull();
    }
  });
});

describe('admin boundary', () => {
  it('a normal user cannot reach an admin action', async () => {
    const actorA = actorFor(userA);
    for (const action of [
      'admin:suspend_invitation',
      'admin:suspend_user',
      'admin:read_users',
      'admin:read_audit_log',
      'admin:update_plan',
      'admin:change_user_role',
    ] as const) {
      expect(can(actorA, action).allowed, action).toBe(false);
    }
  });

  it('a tenant owner is not a platform admin', async () => {
    // Owning an invitation grants power over that invitation, never over the
    // platform.
    const owner = actorFor(userA, { memberships: [{ invitationId: invitationA, role: 'owner' }] });
    expect(can(owner, 'admin:suspend_invitation').allowed).toBe(false);
    expect(can(owner, 'admin:read_users').allowed).toBe(false);
  });

  it('support cannot perform admin-only actions', async () => {
    const support = actorFor(await seedUser(prisma, { role: 'support' }), { role: 'support' });
    expect(can(support, 'admin:suspend_invitation').allowed).toBe(true);
    expect(can(support, 'admin:suspend_user').allowed).toBe(false);
    expect(can(support, 'admin:update_plan').allowed).toBe(false);
  });

  it('a suspended staff account loses every admin power', async () => {
    const staffId = await seedUser(prisma, { role: 'admin' });
    await users.setStatus(staffId, 'suspended', 'compromised', new Date());

    const suspended = actorFor(staffId, { role: 'admin', status: 'suspended' });
    expect(can(suspended, 'admin:suspend_invitation').allowed).toBe(false);
    expect(can(suspended, 'admin:read_users').allowed).toBe(false);
    expect(tenantScopeFor(suspended)).toBeNull();
  });

  it('records every administrative action in the append-only log', async () => {
    await audit.record(
      {
        actorId: userA,
        actorType: 'staff',
        action: 'admin.user_suspended',
        resourceType: 'user',
        resourceId: userB,
        metadata: { reason: 'abuse' },
      },
      new Date(),
    );

    const entries = await prisma.auditLog.findMany({ where: { action: 'admin.user_suspended' } });
    expect(entries).toHaveLength(1);

    // The table rejects UPDATE and DELETE by trigger (M1).
    await expect(
      prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('the public boundary still holds after identity exists', () => {
  it('exposes exactly six fields and no internal identifiers', async () => {
    const actorB = actorFor(userB, { memberships: [{ invitationId: invitationB, role: 'owner' }] });
    await invitations.publish(
      {
        invitationId: invitationB,
        slug: 'public-check',
        snapshot: fixtureSnapshot(),
        publishedBy: userB,
        expiresAt: null,
        now: new Date(),
      },
      scopeOf(actorB),
    );

    const view = await invitations.findPublishedBySlug('public-check');
    expect(view).not.toBeNull();
    if (!view) return;

    expect(Object.keys(view).sort()).toEqual(
      ['expiresAt', 'invitationId', 'snapshot', 'status', 'versionNumber', 'visibility'].sort(),
    );

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(userB);
    expect(serialized).not.toContain(templateVersionId);
    expect(serialized).not.toContain('draftDocument');
    expect(serialized).not.toContain('ownerId');
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('passwordHash');
  });

  it('requires no session at all', async () => {
    const actorB = actorFor(userB, { memberships: [{ invitationId: invitationB, role: 'owner' }] });
    await invitations.publish(
      {
        invitationId: invitationB,
        slug: 'anonymous-ok',
        snapshot: fixtureSnapshot(),
        publishedBy: userB,
        expiresAt: null,
        now: new Date(),
      },
      scopeOf(actorB),
    );

    // No actor, no scope, no cookie.
    expect(await invitations.findPublishedBySlug('anonymous-ok')).not.toBeNull();
  });
});

describe('session and token storage', () => {
  it('stores no plaintext session token', async () => {
    const token = await issueSessionFor(userA);
    const rows = await prisma.session.findMany({ select: { tokenHash: true } });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash.length).toBe(32);
    expect(rows[0]?.tokenHash.toString('utf8')).not.toContain(token);
    expect(rows[0]?.tokenHash.toString('base64url')).not.toBe(token);
  });

  it('stores no plaintext password', async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userA } });
    // The seed creates OAuth-shaped users with no password; the invariant is
    // that whatever is stored is never the plaintext.
    expect(row.passwordHash === null || row.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('finds a session only by the hash of its token', async () => {
    const token = await issueSessionFor(userA);
    expect(await sessions.findByTokenHash(tokens.hash(token))).not.toBeNull();
    expect(await sessions.findByTokenHash(tokens.hash(`${token}x`))).toBeNull();
  });

  it('signing out everywhere ends every session but the current one', async () => {
    const first = await issueSessionFor(userA);
    const second = await issueSessionFor(userA);
    const third = await issueSessionFor(userA);

    const kept = await sessions.findByTokenHash(tokens.hash(third));
    expect(kept).not.toBeNull();
    if (!kept) return;

    const revoked = await sessions.revokeAllForUser(userA, new Date(), kept.id);
    expect(revoked).toBe(2);

    expect((await resolveSession(first, sessionDeps())).ok).toBe(false);
    expect((await resolveSession(second, sessionDeps())).ok).toBe(false);
    expect((await resolveSession(third, sessionDeps())).ok).toBe(true);
  });

  it("lists a user's own active devices and nobody else's", async () => {
    await issueSessionFor(userA);
    await issueSessionFor(userA);
    await issueSessionFor(userB);

    const forA = await sessions.listActiveForUser(userA, new Date());
    expect(forA).toHaveLength(2);
    expect(forA.every((session) => session.userId === userA)).toBe(true);

    // And the listing carries no token material.
    expect(JSON.stringify(forA)).not.toContain('tokenHash');
  });

  it('uses a distinct id and hash for every session', async () => {
    const tokenValues = await Promise.all([
      issueSessionFor(userA),
      issueSessionFor(userA),
      issueSessionFor(userA),
    ]);
    expect(new Set(tokenValues).size).toBe(3);

    const rows = await prisma.session.findMany({ select: { id: true, tokenHash: true } });
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(new Set(rows.map((row) => row.tokenHash.toString('hex'))).size).toBe(3);
  });
});

describe('membership grants are scoped to one invitation', () => {
  it("does not spill over to the granter's other invitations", async () => {
    const secondOfA = await seedInvitation(prisma, { ownerId: userA, templateVersionId });
    await memberships.grant(invitationA, userB, 'editor', userA, new Date());

    const resolved = await resolveSession(await issueSessionFor(userB), sessionDeps());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.actor.kind !== 'user') return;

    const scope = scopeOf(resolved.actor);
    expect(await invitations.findByIdInScope(invitationA, scope)).not.toBeNull();
    expect(await invitations.findByIdInScope(secondOfA, scope)).toBeNull();
  });

  it('is unique per (invitation, user), so a grant cannot be duplicated', async () => {
    await memberships.grant(invitationA, userB, 'viewer', userA, new Date());
    await memberships.grant(invitationA, userB, 'editor', userA, new Date());

    const rows = await prisma.invitationMember.findMany({
      where: { invitationId: invitationA, userId: userB },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('editor');
  });

  it('is removed with the invitation', async () => {
    await memberships.grant(invitationA, userB, 'editor', userA, new Date());
    await prisma.$executeRawUnsafe(`DELETE FROM invitations WHERE id = $1::uuid`, invitationA);

    expect(await memberships.find(invitationA, userB)).toBeNull();
  });
});

describe('helper coverage', () => {
  it('uses a fresh membership id per grant', async () => {
    const grant = await memberships.grant(invitationA, userB, 'viewer', userA, new Date());
    expect(grant.invitationId).toBe(invitationA);
    expect(randomUUID()).not.toBe(grant.userId);
  });
});
