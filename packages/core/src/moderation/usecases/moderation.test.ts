import { beforeEach, describe, expect, it } from 'vitest';

import {
  type Actor,
  type AdminAuditFilter,
  type AdminAuditRecord,
  type AdminAuditRow,
  type AdminInvitationFilter,
  type AdminInvitationRow,
  type AdminPage,
  type AdminRepository,
  type AdminUserFilter,
  type AdminUserRow,
  type CdnPurger,
  type Clock,
  type InvitationRepository,
  type InvitationStatus,
  type ModerationAuditEntry,
  NO_CDN_PURGER,
  type TenantScope,
  type UserRole,
  adminListAuditLog,
  adminListInvitations,
  adminListUsers,
  invitationCacheTag,
  moderateInvitation,
} from '@zfaf/core';

/**
 * The kill switch and the console (D8.5–D8.7).
 *
 * Two questions these tests exist to answer, and they are the only two that
 * matter if the code is wrong: **can somebody who should not, do this**, and
 * **is what happened written down truthfully**.
 */

const NOW = new Date('2026-08-16T12:00:00.000Z');
const clock: Clock = { now: () => NOW };

const INVITATION_ID = '2f6c0f6a-1b1a-4e40-9a1e-000000000001';
const OWNER_ID = '2f6c0f6a-1b1a-4e40-9a1e-0000000000ff';

function actor(role: UserRole, userId = 'staff-1'): Actor {
  return {
    kind: 'user',
    userId,
    role,
    emailVerified: true,
    status: 'active',
    sessionId: 'session-1',
    memberships: [],
  };
}

const support = actor('support');
const admin = actor('admin');
const customer = actor('customer', OWNER_ID);
const anonymous: Actor = { kind: 'anonymous', ipHash: 'abc' };

function invitationRow(status: InvitationStatus = 'PUBLISHED'): AdminInvitationRow {
  return {
    id: INVITATION_ID,
    slug: 'ahmad-and-sara',
    title: 'Ahmad & Sara',
    status,
    ownerId: OWNER_ID,
    ownerEmail: 'owner@example.test',
    eventDate: '2026-09-20',
    rsvpCount: 12,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class FakeAdminRepository implements AdminRepository {
  invitation: AdminInvitationRow | null = invitationRow();
  lastUserFilter: AdminUserFilter | null = null;
  lastInvitationFilter: AdminInvitationFilter | null = null;
  lastAuditFilter: AdminAuditFilter | null = null;

  async listUsers(filter: AdminUserFilter): Promise<AdminPage<AdminUserRow>> {
    this.lastUserFilter = filter;
    return { rows: [], total: 0 };
  }
  async listInvitations(filter: AdminInvitationFilter): Promise<AdminPage<AdminInvitationRow>> {
    this.lastInvitationFilter = filter;
    return { rows: this.invitation ? [this.invitation] : [], total: this.invitation ? 1 : 0 };
  }
  async listAuditLog(filter: AdminAuditFilter): Promise<AdminPage<AdminAuditRow>> {
    this.lastAuditFilter = filter;
    return { rows: [], total: 0 };
  }
  async findInvitationForModeration(): Promise<AdminInvitationRow | null> {
    return this.invitation;
  }
}

class FakeInvitations {
  transitions: { id: string; next: InvitationStatus; scope: TenantScope }[] = [];
  succeeds = true;

  async transitionStatus(id: string, scope: TenantScope, next: InvitationStatus): Promise<boolean> {
    if (!this.succeeds) return false;
    this.transitions.push({ id, next, scope });
    return true;
  }
}

class RecordingPurger implements CdnPurger {
  readonly key = 'recording';
  readonly tags: string[] = [];
  outcome: { purged: true } | { purged: false; reason: string } = { purged: true };

  async purgeTag(tag: string) {
    this.tags.push(tag);
    return this.outcome;
  }
}

describe('moderateInvitation', () => {
  let repository: FakeAdminRepository;
  let invitations: FakeInvitations;
  let cdn: RecordingPurger;
  let recorded: ModerationAuditEntry[];

  beforeEach(() => {
    repository = new FakeAdminRepository();
    invitations = new FakeInvitations();
    cdn = new RecordingPurger();
    recorded = [];
  });

  const deps = () => ({
    admin: repository,
    invitations: invitations as unknown as InvitationRepository,
    cdn,
    clock,
    recordModeration: async (entry: ModerationAuditEntry) => {
      recorded.push(entry);
    },
  });

  it('suspends a published invitation and purges the edge', async () => {
    const result = await moderateInvitation(
      { actor: support, invitationId: INVITATION_ID, action: 'suspend', reason: 'impersonation' },
      deps(),
    );

    expect(result).toMatchObject({ ok: true, status: 'SUSPENDED', purged: true });
    expect(invitations.transitions[0]?.next).toBe('SUSPENDED');
    // By tag, so the page and its OG image go together and an old slug still
    // in circulation is covered too.
    expect(cdn.tags).toEqual([invitationCacheTag(INVITATION_ID)]);
  });

  it('unsuspends back to PAUSED, never straight to PUBLISHED', async () => {
    // Moderation lifting a block does not decide something should be live
    // again. The owner does, by publishing.
    repository.invitation = invitationRow('SUSPENDED');
    const result = await moderateInvitation(
      { actor: support, invitationId: INVITATION_ID, action: 'unsuspend', reason: 'resolved' },
      deps(),
    );

    expect(result).toMatchObject({ ok: true, status: 'PAUSED' });
  });

  it('refuses an owner trying to suspend or unsuspend', async () => {
    for (const action of ['suspend', 'unsuspend'] as const) {
      const result = await moderateInvitation(
        { actor: customer, invitationId: INVITATION_ID, action, reason: 'because' },
        deps(),
      );
      expect(result).toEqual({ ok: false, code: 'FORBIDDEN', message: 'Not permitted' });
    }
    expect(invitations.transitions).toHaveLength(0);
  });

  it('refuses an anonymous caller', async () => {
    const result = await moderateInvitation(
      { actor: anonymous, invitationId: INVITATION_ID, action: 'suspend', reason: 'spam' },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('refuses a suspension with no stated reason', async () => {
    // A moderation action nobody can justify six months later is one the
    // platform cannot defend.
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const result = await moderateInvitation(
        { actor: support, invitationId: INVITATION_ID, action: 'suspend', reason },
        deps(),
      );
      expect(result).toMatchObject({ ok: false, code: 'INVALID' });
    }
    expect(invitations.transitions).toHaveLength(0);
  });

  it('refuses an illegal transition rather than forcing it', async () => {
    repository.invitation = invitationRow('SUSPENDED');
    const result = await moderateInvitation(
      { actor: support, invitationId: INVITATION_ID, action: 'suspend', reason: 'again' },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' });
  });

  it('answers NOT_FOUND for an invitation that does not exist', async () => {
    repository.invitation = null;
    const result = await moderateInvitation(
      { actor: support, invitationId: INVITATION_ID, action: 'suspend', reason: 'spam' },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('still suspends when the purge fails, and says so', async () => {
    // The row change protects everyone whose request reaches the origin. Losing
    // it because a third-party API was down would be the worst of both.
    cdn.outcome = { purged: false, reason: 'cloudflare responded 502' };

    const result = await moderateInvitation(
      { actor: admin, invitationId: INVITATION_ID, action: 'suspend', reason: 'stolen photo' },
      deps(),
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'SUSPENDED',
      purged: false,
      purgeError: 'cloudflare responded 502',
    });
    expect(invitations.transitions).toHaveLength(1);
  });

  it('reports honestly when no CDN is configured', async () => {
    const result = await moderateInvitation(
      { actor: admin, invitationId: INVITATION_ID, action: 'suspend', reason: 'spam' },
      { ...deps(), cdn: NO_CDN_PURGER },
    );
    expect(result).toMatchObject({ ok: true, purged: false, purgeError: 'no CDN configured' });
  });

  it('records the reason, both statuses and the purge outcome', async () => {
    cdn.outcome = { purged: false, reason: 'timeout' };
    await moderateInvitation(
      { actor: admin, invitationId: INVITATION_ID, action: 'suspend', reason: '  reported  ' },
      deps(),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorId: 'staff-1',
      invitationId: INVITATION_ID,
      action: 'suspend',
      // Trimmed, because a reason of "  " must not pass as one.
      reason: 'reported',
      previousStatus: 'PUBLISHED',
      nextStatus: 'SUSPENDED',
      purged: false,
      purgeError: 'timeout',
      at: NOW,
    });
  });

  it('writes no audit entry when the row did not change', async () => {
    invitations.succeeds = false;
    const result = await moderateInvitation(
      { actor: support, invitationId: INVITATION_ID, action: 'suspend', reason: 'spam' },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(recorded).toEqual([]);
  });

  it('uses a named system scope, not the operator’s own reach', async () => {
    await moderateInvitation(
      { actor: support, invitationId: INVITATION_ID, action: 'suspend', reason: 'spam' },
      deps(),
    );
    expect(invitations.transitions[0]?.scope.actorDescription).toBe('system:moderation');
  });
});

describe('the admin console reads', () => {
  let repository: FakeAdminRepository;
  let audited: AdminAuditRecord[];

  beforeEach(() => {
    repository = new FakeAdminRepository();
    audited = [];
  });

  const deps = () => ({
    admin: repository,
    clock,
    recordAdminAccess: async (entry: AdminAuditRecord) => {
      audited.push(entry);
    },
  });

  it('lets support browse users and invitations', async () => {
    expect((await adminListUsers({ actor: support }, deps())).ok).toBe(true);
    expect((await adminListInvitations({ actor: support }, deps())).ok).toBe(true);
  });

  it('refuses a customer, and does not audit an access that never happened', async () => {
    for (const call of [adminListUsers, adminListInvitations, adminListAuditLog]) {
      expect(await call({ actor: customer }, deps())).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(audited).toEqual([]);
  });

  it('refuses an anonymous caller', async () => {
    expect(await adminListUsers({ actor: anonymous }, deps())).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('keeps the audit log above support', async () => {
    // Support may do support work; reading the record of what operators did is
    // a different question (docs/09 §4).
    expect(await adminListAuditLog({ actor: support }, deps())).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect((await adminListAuditLog({ actor: admin }, deps())).ok).toBe(true);
  });

  it('audits every successful read, naming the operator and the search term', async () => {
    await adminListUsers({ actor: support, query: '  owner@example.test  ' }, deps());

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      actorId: 'staff-1',
      action: 'admin.users.list',
      resourceType: 'user',
      at: NOW,
    });
    expect(audited[0]?.metadata['query']).toBe('owner@example.test');
  });

  it('records the search term but not the accounts it matched', async () => {
    // Copying matched rows into the audit table would duplicate the very data
    // the console exists to handle carefully.
    await adminListUsers({ actor: support, query: 'sara' }, deps());
    const serialised = JSON.stringify(audited[0]?.metadata);
    expect(serialised).toContain('sara');
    expect(serialised).not.toContain('owner@example.test');
  });

  it('audits a read of the audit log itself', async () => {
    await adminListAuditLog({ actor: admin }, deps());
    expect(audited[0]?.action).toBe('admin.audit.list');
  });

  it('bounds the page size however large a caller asks for', async () => {
    await adminListUsers({ actor: support, limit: 100_000, offset: -5 }, deps());
    expect(repository.lastUserFilter).toMatchObject({ limit: 100, offset: 0 });
  });

  it('treats an empty search as no search', async () => {
    await adminListUsers({ actor: support, query: '   ' }, deps());
    expect(repository.lastUserFilter?.query).toBeUndefined();
  });

  it('ignores a status filter that is not a real status', async () => {
    await adminListInvitations({ actor: support, status: 'DROP TABLE invitations' }, deps());
    expect(repository.lastInvitationFilter?.status).toBeUndefined();
  });

  it('passes a real status through', async () => {
    await adminListInvitations({ actor: support, status: 'SUSPENDED' }, deps());
    expect(repository.lastInvitationFilter?.status).toBe('SUSPENDED');
  });

  it('never returns a guest name, because no row carries one', async () => {
    const result = await adminListInvitations({ actor: support }, deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.page.rows[0];
    expect(row).toBeDefined();
    // A count, and no key that could hold a person.
    expect(row?.rsvpCount).toBe(12);
    expect(Object.keys(row ?? {})).not.toContain('rsvps');
    expect(JSON.stringify(row)).not.toMatch(/phone|guest|note/i);
  });
});
