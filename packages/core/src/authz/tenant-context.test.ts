import { describe, expect, it } from 'vitest';

import type { Actor, MembershipRole, UserRole } from './actor.js';
import {
  isWellFormedTenantId,
  resolveTenantContext,
  verifiesResourceTenancy,
} from './tenant-context.js';

/**
 * Tenant identifiers arriving from a client are input, not facts.
 *
 * This is the single most common multi-tenant vulnerability: the attacker does
 * not break anything, they change a value. Every case below supplies a *valid,
 * real* identifier belonging to someone else — the situation an exploit is
 * actually in — rather than malformed junk.
 */

const TENANT_A = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b';
const TENANT_B = '018f3a2b-2c4d-7e8f-9a0b-1c2d3e4f5a6c';
const TENANT_C = '018f3a2b-3c4d-7e8f-9a0b-1c2d3e4f5a6d';

function user(options: {
  userId?: string;
  role?: UserRole;
  status?: 'active' | 'suspended' | 'pending_deletion';
  memberships?: ReadonlyArray<{ invitationId: string; role: MembershipRole }>;
}): Actor {
  return {
    kind: 'user',
    userId: options.userId ?? 'user-1',
    role: options.role ?? 'customer',
    emailVerified: true,
    status: options.status ?? 'active',
    sessionId: 'session-1',
    memberships: options.memberships ?? [],
  };
}

describe('tenant id shape', () => {
  it('accepts a well-formed UUID', () => {
    expect(isWellFormedTenantId(TENANT_A)).toBe(true);
  });

  it.each([
    ['a number', 1],
    ['an object', { id: TENANT_A }],
    ['an array', [TENANT_A]],
    ['null', null],
    ['an empty string', ''],
    ['a sequential id', '1'],
    ['SQL fragment', "' OR '1'='1"],
    ['a path traversal', '../../etc/passwd'],
    ['a UUID with trailing content', `${TENANT_A} OR 1=1`],
    ['a nil UUID', '00000000-0000-0000-0000-000000000000'],
  ])('rejects %s', (_label, candidate) => {
    expect(isWellFormedTenantId(candidate)).toBe(false);
  });
});

describe('resolveTenantContext — the claimed tenant is checked against memberships', () => {
  it('resolves a tenant the actor actually belongs to', () => {
    const actor = user({ memberships: [{ invitationId: TENANT_A, role: 'owner' }] });
    const result = resolveTenantContext(actor, TENANT_A);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.tenantId).toBe(TENANT_A);
      expect(result.context.role).toBe('owner');
    }
  });

  it('refuses a valid tenant id the actor does not belong to', () => {
    // The core case: the id is real and well-formed. Knowing it is not enough.
    const actor = user({ memberships: [{ invitationId: TENANT_A, role: 'owner' }] });
    const result = resolveTenantContext(actor, TENANT_B);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('NOT_A_MEMBER');
  });

  it('refuses an actor with no memberships at all', () => {
    const result = resolveTenantContext(user({}), TENANT_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('NOT_A_MEMBER');
  });

  it('refuses a malformed tenant id before any lookup happens', () => {
    const actor = user({ memberships: [{ invitationId: TENANT_A, role: 'owner' }] });
    for (const malformed of ["' OR 1=1", '../../secret', 12345, {}]) {
      const result = resolveTenantContext(actor, malformed);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe('MALFORMED_TENANT_ID');
    }
  });

  it('refuses an anonymous actor', () => {
    const result = resolveTenantContext({ kind: 'anonymous', ipHash: 'x' }, TENANT_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('NOT_AUTHENTICATED');
  });

  it('refuses a suspended account even for a tenant it belongs to', () => {
    const actor = user({
      status: 'suspended',
      memberships: [{ invitationId: TENANT_A, role: 'owner' }],
    });
    const result = resolveTenantContext(actor, TENANT_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('ACCOUNT_NOT_ACTIVE');
  });

  it('does not grant staff a tenant they are not a member of', () => {
    // Staff read across tenants through an auditable staff scope, not by
    // presenting a tenant id. Otherwise a compromised staff account becomes a
    // universal key with no record of what it touched.
    for (const role of ['support', 'admin', 'superadmin'] as const) {
      const staff = user({ role, memberships: [] });
      const result = resolveTenantContext(staff, TENANT_B);
      expect(result.ok, role).toBe(false);
    }
  });
});

describe('resolveTenantContext — the no-tenant-supplied case', () => {
  it('falls back only when the choice is unambiguous', () => {
    const actor = user({ memberships: [{ invitationId: TENANT_A, role: 'editor' }] });
    const result = resolveTenantContext(actor, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.tenantId).toBe(TENANT_A);
  });

  it('refuses to guess when the actor belongs to several tenants', () => {
    // Silently substituting a tenant is how an authorization bug becomes
    // invisible: the request succeeds, against the wrong data.
    const actor = user({
      memberships: [
        { invitationId: TENANT_A, role: 'owner' },
        { invitationId: TENANT_B, role: 'editor' },
      ],
    });
    const result = resolveTenantContext(actor, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('NO_MEMBERSHIPS');
  });

  it('refuses when the actor belongs to none', () => {
    const result = resolveTenantContext(user({}), null);
    expect(result.ok).toBe(false);
  });
});

describe('verifiesResourceTenancy — the claim and the row must agree', () => {
  const resourceA = { id: TENANT_A, ownerId: 'user-a' };

  it('accepts the owner', () => {
    expect(verifiesResourceTenancy(user({ userId: 'user-a' }), TENANT_A, resourceA)).toBe(true);
  });

  it('accepts a member', () => {
    const member = user({
      userId: 'user-b',
      memberships: [{ invitationId: TENANT_A, role: 'editor' }],
    });
    expect(verifiesResourceTenancy(member, TENANT_A, resourceA)).toBe(true);
  });

  it('refuses a stranger holding the correct id', () => {
    expect(verifiesResourceTenancy(user({ userId: 'user-x' }), TENANT_A, resourceA)).toBe(false);
  });

  it('refuses when the claimed tenant does not match the resource', () => {
    // A real membership pointed at someone else's row.
    const member = user({
      userId: 'user-b',
      memberships: [{ invitationId: TENANT_A, role: 'editor' }],
    });
    expect(verifiesResourceTenancy(member, TENANT_C, resourceA)).toBe(false);
  });

  it('refuses a forged tenant claim that would make a foreign row look owned', () => {
    const attacker = user({
      userId: 'user-x',
      memberships: [{ invitationId: TENANT_B, role: 'owner' }],
    });
    // Claiming their own tenant id while addressing someone else's resource.
    expect(verifiesResourceTenancy(attacker, TENANT_B, resourceA)).toBe(false);
  });

  it('refuses a malformed claim outright', () => {
    const owner = user({ userId: 'user-a' });
    expect(verifiesResourceTenancy(owner, "' OR 1=1", resourceA)).toBe(false);
  });

  it('refuses anonymous and suspended actors', () => {
    expect(verifiesResourceTenancy({ kind: 'anonymous', ipHash: 'x' }, TENANT_A, resourceA)).toBe(
      false,
    );
    expect(
      verifiesResourceTenancy(user({ userId: 'user-a', status: 'suspended' }), TENANT_A, resourceA),
    ).toBe(false);
  });
});
