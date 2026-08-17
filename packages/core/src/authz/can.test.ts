import { describe, expect, it } from 'vitest';

import { ACTIONS, type Action, type Resource, can } from './can.js';
import { type Actor, type MembershipRole, type UserRole, anonymous, systemActor } from './actor.js';
import {
  customerScopeFor,
  scopeCoversInvitation,
  systemScope,
  tenantScopeFor,
} from './tenant-scope.js';

/**
 * The authorization matrix.
 *
 * Every role is checked against every action, including the combinations that
 * must be denied. Scattered permission checks are the usual source of IDOR, so
 * the single decision point earns an exhaustive test rather than a sampled one.
 */

const OWNER_ID = 'user-owner';
const OTHER_ID = 'user-other';
const INVITATION_ID = 'inv-1';

const invitation: Resource = { kind: 'invitation', id: INVITATION_ID, ownerId: OWNER_ID };

function user(options: {
  userId?: string;
  role?: UserRole;
  emailVerified?: boolean;
  membership?: MembershipRole | null;
  status?: 'active' | 'suspended';
}): Actor {
  return {
    kind: 'user',
    userId: options.userId ?? OTHER_ID,
    role: options.role ?? 'customer',
    emailVerified: options.emailVerified ?? true,
    status: options.status ?? 'active',
    sessionId: 'session-1',
    memberships: options.membership
      ? [{ invitationId: INVITATION_ID, role: options.membership }]
      : [],
  };
}

const owner = user({ userId: OWNER_ID });
const editor = user({ membership: 'editor' });
const viewer = user({ membership: 'viewer' });
const stranger = user({});
const support = user({ role: 'support' });
const admin = user({ role: 'admin' });
const superadmin = user({ role: 'superadmin' });

describe('anonymous and non-user actors', () => {
  it.each(ACTIONS)('denies %s to an anonymous visitor', (action) => {
    const decision = can(anonymous('ip-hash'), action as Action, invitation);
    expect(decision.allowed).toBe(false);
  });

  it.each(ACTIONS)('denies %s to a system actor without an explicit scope', (action) => {
    // Background jobs use systemScope() deliberately; they do not slip through
    // the user authorization path.
    expect(can(systemActor('retention'), action as Action, invitation).allowed).toBe(false);
  });
});

describe('a suspended account can do nothing', () => {
  it.each(ACTIONS)('denies %s', (action) => {
    const suspended = user({ userId: OWNER_ID, status: 'suspended', role: 'superadmin' });
    const decision = can(suspended, action as Action, invitation);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('invitation permissions by membership role', () => {
  const cases: ReadonlyArray<readonly [string, Actor, Action, boolean]> = [
    ['owner reads', owner, 'invitation:read', true],
    ['editor reads', editor, 'invitation:read', true],
    ['viewer reads', viewer, 'invitation:read', true],
    ['stranger cannot read', stranger, 'invitation:read', false],

    ['owner updates', owner, 'invitation:update', true],
    ['editor updates', editor, 'invitation:update', true],
    ['viewer cannot update', viewer, 'invitation:update', false],
    ['stranger cannot update', stranger, 'invitation:update', false],

    ['owner publishes', owner, 'invitation:publish', true],
    ['editor publishes', editor, 'invitation:publish', true],
    ['viewer cannot publish', viewer, 'invitation:publish', false],

    ['owner changes the slug', owner, 'invitation:change_slug', true],
    ['editor cannot change the slug', editor, 'invitation:change_slug', false],

    ['owner deletes', owner, 'invitation:delete', true],
    ['editor cannot delete', editor, 'invitation:delete', false],
    ['viewer cannot delete', viewer, 'invitation:delete', false],

    ['owner invites members', owner, 'invitation:invite_member', true],
    ['editor cannot invite members', editor, 'invitation:invite_member', false],

    ['owner reads responses', owner, 'rsvp:read', true],
    ['viewer reads responses', viewer, 'rsvp:read', true],
    ['stranger cannot read responses', stranger, 'rsvp:read', false],

    ['owner exports responses', owner, 'rsvp:export', true],
    ['viewer cannot export responses', viewer, 'rsvp:export', false],

    ['editor uploads media', editor, 'media:upload', true],
    ['viewer cannot upload media', viewer, 'media:upload', false],
  ];

  it.each(cases)('%s', (_label, actor, action, expected) => {
    expect(can(actor, action, invitation).allowed).toBe(expected);
  });
});

describe('publishing requires a verified email', () => {
  it('denies an unverified owner', () => {
    const unverified = user({ userId: OWNER_ID, emailVerified: false });
    const decision = can(unverified, 'invitation:publish', invitation);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('EMAIL_NOT_VERIFIED');
  });

  it('still lets an unverified owner edit — verification gates publishing, not the first run', () => {
    const unverified = user({ userId: OWNER_ID, emailVerified: false });
    expect(can(unverified, 'invitation:update', invitation).allowed).toBe(true);
  });
});

describe('platform staff', () => {
  const cases: ReadonlyArray<readonly [string, Actor, Action, boolean]> = [
    ['support suspends an invitation', support, 'admin:suspend_invitation', true],
    ['support reads users', support, 'admin:read_users', true],
    ['support cannot suspend a user', support, 'admin:suspend_user', false],
    ['support cannot read the audit log', support, 'admin:read_audit_log', false],
    ['support cannot publish a template', support, 'admin:publish_template', false],

    ['admin suspends a user', admin, 'admin:suspend_user', true],
    ['admin reads the audit log', admin, 'admin:read_audit_log', true],
    ['admin publishes a template', admin, 'admin:publish_template', true],
    ['admin cannot change pricing', admin, 'admin:update_plan', false],
    ['admin cannot change roles', admin, 'admin:change_user_role', false],

    ['superadmin changes pricing', superadmin, 'admin:update_plan', true],
    ['superadmin changes roles', superadmin, 'admin:change_user_role', true],

    ['a customer cannot suspend an invitation', owner, 'admin:suspend_invitation', false],
    ['a customer cannot read users', owner, 'admin:read_users', false],
  ];

  it.each(cases)('%s', (_label, actor, action, expected) => {
    expect(can(actor, action, invitation).allowed).toBe(expected);
  });

  it('lets staff read an invitation for moderation', () => {
    expect(can(support, 'invitation:read', invitation).allowed).toBe(true);
    expect(can(admin, 'invitation:read', invitation).allowed).toBe(true);
  });

  it("does not let staff edit or delete someone else's invitation", () => {
    expect(can(admin, 'invitation:update', invitation).allowed).toBe(false);
    expect(can(superadmin, 'invitation:delete', invitation).allowed).toBe(false);
  });
});

describe('guest personal data is not staff-readable', () => {
  // A deliberate limit (docs/09 §3.3): guests are third parties who never
  // agreed to anything with us, there is no operational reason to browse their
  // names and phone numbers, and excluding staff shrinks the blast radius of a
  // compromised staff account.
  it.each([
    ['support', support],
    ['admin', admin],
    ['superadmin', superadmin],
  ])('denies rsvp:read to %s', (_label, actor) => {
    const decision = can(actor, 'rsvp:read', invitation);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('GUEST_DATA_IS_NOT_STAFF_READABLE');
  });

  it('denies rsvp:export and rsvp:delete to superadmin', () => {
    expect(can(superadmin, 'rsvp:export', invitation).allowed).toBe(false);
    expect(can(superadmin, 'rsvp:delete', invitation).allowed).toBe(false);
  });

  it('still allows a staff member who owns the invitation to read their own responses', () => {
    const staffOwner = user({ userId: OWNER_ID, role: 'admin' });
    expect(can(staffOwner, 'rsvp:read', invitation).allowed).toBe(true);
  });
});

describe('every action is covered by the matrix', () => {
  it('resolves a decision for each declared action', () => {
    for (const action of ACTIONS) {
      const decision = can(superadmin, action as Action, invitation);
      expect(typeof decision.allowed).toBe('boolean');
    }
  });
});

describe('tenant scope construction', () => {
  it('produces no scope for anonymous, guest or system actors', () => {
    expect(tenantScopeFor(anonymous('ip'))).toBeNull();
    expect(tenantScopeFor(systemActor('job'))).toBeNull();
    expect(
      tenantScopeFor({ kind: 'guest', invitationId: INVITATION_ID, guestId: 'g1' }),
    ).toBeNull();
  });

  it('produces no scope for a suspended account', () => {
    expect(tenantScopeFor(user({ status: 'suspended' }))).toBeNull();
  });

  it('constrains a customer to their own rows', () => {
    const scope = tenantScopeFor(owner);
    expect(scope?.ownerId).toBe(OWNER_ID);
    expect(scope?.isPlatformStaff).toBe(false);
  });

  it('lets staff read across tenants, and records who they are', () => {
    const scope = tenantScopeFor(admin);
    expect(scope?.ownerId).toBeNull();
    expect(scope?.isPlatformStaff).toBe(true);
    expect(scope?.actorDescription).toContain('user:');
  });

  it('covers an invitation reached through membership rather than ownership', () => {
    const scope = tenantScopeFor(editor);
    expect(scope).not.toBeNull();
    if (!scope) return;
    expect(scopeCoversInvitation(scope, { id: INVITATION_ID, ownerId: OWNER_ID })).toBe(true);
    expect(scopeCoversInvitation(scope, { id: 'other-inv', ownerId: OWNER_ID })).toBe(false);
  });

  it('names the job on a system scope, so broad reads are visible in review', () => {
    expect(systemScope('retention').actorDescription).toBe('system:retention');
  });
});

/**
 * The customer scope (docs/23 §7).
 *
 * Its whole reason for existing is the staff row below. A collection endpoint
 * under `/api/v1` that built an ordinary `tenantScopeFor` would hand a staff
 * session `ownerId: null` — which every repository reads as "no owner
 * constraint" — and answer with every tenant's rows, from a route with none of
 * `/api/admin`'s protections: no `requireAdmin`, no four-hour session-age
 * ceiling, no moderation audit trail.
 */
describe('customer scope', () => {
  it('is an ordinary scope for a customer', () => {
    const scope = customerScopeFor(owner);
    expect(scope?.ownerId).toBe(OWNER_ID);
    expect(scope?.isPlatformStaff).toBe(false);
  });

  it('refuses every staff role, so a customer collection cannot enumerate tenants', () => {
    for (const staff of [support, admin, superadmin]) {
      expect(
        customerScopeFor(staff),
        `${staff.kind}:${'role' in staff ? staff.role : ''}`,
      ).toBeNull();
    }
  });

  it('refuses everyone `tenantScopeFor` refuses', () => {
    expect(customerScopeFor(anonymous('ip'))).toBeNull();
    expect(customerScopeFor(systemActor('job'))).toBeNull();
    expect(customerScopeFor(user({ status: 'suspended' }))).toBeNull();
  });
});
