import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type Actor, type PatchAuditEntry, systemClock, updateDraftDocument } from '@zfaf/core';

import { PrismaAuditLogRepository } from '../src/repositories/identity.repository.js';
import { PrismaInvitationRepository } from '../src/repositories/invitation.repository.js';
import {
  resetDatabase,
  seedInvitation,
  seedTemplate,
  seedUser,
  testClient,
} from './helpers/database.js';

/**
 * Autosave against a real PostgreSQL (D5.5, D5.7).
 *
 * The mandatory security requirement for M5 is that a patch naming `/status`
 * or `/ownerId` is **rejected and logged**. A unit test proves the validator
 * says no; only this proves that the row is refused in the database *and* that
 * the attempt survives in an append-only audit table an operator can actually
 * read afterwards.
 *
 * Optimistic concurrency is exercised here for the same reason: version
 * conflicts are a property of concurrent transactions, and a fake repository
 * cannot have them.
 */

let prisma: PrismaClient;
let invitations: PrismaInvitationRepository;
let audit: PrismaAuditLogRepository;
let ownerId: string;
let otherOwnerId: string;
let invitationId: string;

function actorFor(userId: string, invitationIds: string[]): Actor {
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

/** Mirrors what the route does, so the audit shape under test is the real one. */
function recordRejection(entry: PatchAuditEntry): Promise<void> {
  return audit.record(
    {
      actorId: entry.actorId,
      actorType: 'user',
      action: 'invitation.patch_rejected',
      resourceType: 'invitation',
      resourceId: entry.invitationId,
      metadata: {
        violationCount: entry.violations.length,
        paths: entry.violations.map((violation) => violation.path).join(' '),
        reasons: [...new Set(entry.violations.map((violation) => violation.reason))].join(' '),
        actor: entry.actorDescription,
      },
    },
    entry.at,
  );
}

async function currentDocument(): Promise<Record<string, unknown>> {
  const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
  return row.draftDocument as Record<string, unknown>;
}

function deps() {
  return { repository: invitations, clock: systemClock, recordRejection };
}

beforeAll(() => {
  prisma = testClient();
  invitations = new PrismaInvitationRepository(prisma);
  audit = new PrismaAuditLogRepository(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  const templateVersionId = await seedTemplate(prisma);
  ownerId = await seedUser(prisma, 'owner@zfaf.test');
  otherOwnerId = await seedUser(prisma, 'other@zfaf.test');
  invitationId = await seedInvitation(prisma, { ownerId, templateVersionId });

  // A document shaped like the builder's, so the paths under test are real.
  await prisma.invitation.update({
    where: { id: invitationId },
    data: {
      draftDocument: {
        schemaVersion: 1,
        locale: 'ar',
        theme: { colors: { primary: '#b8860b' } },
        sections: [{ id: 'hero', enabled: true, order: 0 }],
        content: {
          couple: { groomName: '', brideName: '', message: null },
          wedding: { date: '2026-09-20', startTime: '20:00' },
          gallery: [],
        },
      },
    },
  });
});

// ── the mandatory test ─────────────────────────────────────────────────────

describe('a patch that reaches for authority', () => {
  it.each(['/status', '/ownerId'])('is rejected and logged: %s', async (path) => {
    const result = await updateDraftDocument(
      {
        actor: actorFor(ownerId, [invitationId]),
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path, value: 'PUBLISHED' }],
      },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_PATCH');

    // Rejected…
    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(invitation.status).toBe('DRAFT');
    expect(invitation.ownerId).toBe(ownerId);
    expect(invitation.draftVersion).toBe(1);

    // …and logged, where an operator can find it.
    const entries = await prisma.auditLog.findMany({
      where: { action: 'invitation.patch_rejected', resourceId: invitationId },
    });
    expect(entries).toHaveLength(1);
    const metadata = entries[0]?.metadata as Record<string, unknown>;
    expect(metadata['paths']).toContain(path);
    expect(entries[0]?.actorId).toBe(ownerId);
  });

  it('does not apply the good half of a mixed patch', async () => {
    const result = await updateDraftDocument(
      {
        actor: actorFor(ownerId, [invitationId]),
        invitationId,
        baseVersion: 1,
        patch: [
          { op: 'replace', path: '/content/couple/groomName', value: 'أحمد' },
          { op: 'replace', path: '/status', value: 'PUBLISHED' },
        ],
      },
      deps(),
    );

    expect(result.ok).toBe(false);
    const document = await currentDocument();
    const content = document['content'] as Record<string, Record<string, unknown>>;
    expect(content['couple']?.['groomName']).toBe('');
  });

  it('records every attempt, so probing is visible as a pattern', async () => {
    for (const path of ['/status', '/ownerId', '/slug', '/publishedVersionId']) {
      await updateDraftDocument(
        {
          actor: actorFor(ownerId, [invitationId]),
          invitationId,
          baseVersion: 1,
          patch: [{ op: 'replace', path, value: 'x' }],
        },
        deps(),
      );
    }

    const entries = await prisma.auditLog.findMany({
      where: { action: 'invitation.patch_rejected' },
    });
    expect(entries).toHaveLength(4);
  });

  it('logs nothing for a patch that is merely wrong about the document', async () => {
    // A path that is allowed but does not exist is a client bug, not an
    // attempt. Recording it would bury the attempts in noise.
    const result = await updateDraftDocument(
      {
        actor: actorFor(ownerId, [invitationId]),
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/content/couple/nickname', value: 'x' }],
      },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PATCH_FAILED');
    expect(await prisma.auditLog.count({ where: { action: 'invitation.patch_rejected' } })).toBe(0);
  });
});

// ── ordinary saving ────────────────────────────────────────────────────────

describe('saving a draft', () => {
  it('applies an allowed patch and advances the version', async () => {
    const result = await updateDraftDocument(
      {
        actor: actorFor(ownerId, [invitationId]),
        invitationId,
        baseVersion: 1,
        patch: [
          { op: 'replace', path: '/content/couple/groomName', value: 'أحمد' },
          { op: 'replace', path: '/theme/colors/primary', value: '#c9a227' },
        ],
      },
      deps(),
    );

    expect(result.ok, result.ok ? '' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(2);

    const document = await currentDocument();
    const content = document['content'] as Record<string, Record<string, unknown>>;
    expect(content['couple']?.['groomName']).toBe('أحمد');
    expect(
      (document['theme'] as Record<string, Record<string, unknown>>)['colors']?.['primary'],
    ).toBe('#c9a227');
  });

  it('appends to an array', async () => {
    const result = await updateDraftDocument(
      {
        actor: actorFor(ownerId, [invitationId]),
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'add', path: '/content/gallery/-', value: { id: 'g1' } }],
      },
      deps(),
    );

    expect(result.ok).toBe(true);
    const document = await currentDocument();
    const content = document['content'] as Record<string, unknown[]>;
    expect(content['gallery']).toHaveLength(1);
  });

  it('refuses an actor with no membership', async () => {
    const result = await updateDraftDocument(
      {
        actor: actorFor(otherOwnerId, []),
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/content/couple/groomName', value: 'أحمد' }],
      },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Indistinguishable from "no such invitation": a different answer would
    // make the endpoint an existence oracle for other people's ids.
    expect(result.code).toBe('NOT_FOUND');
  });
});

// ── concurrency ────────────────────────────────────────────────────────────

describe('two devices saving at once', () => {
  it('reports a conflict rather than overwriting', async () => {
    const actor = actorFor(ownerId, [invitationId]);

    const first = await updateDraftDocument(
      {
        actor,
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/content/couple/groomName', value: 'أحمد' }],
      },
      deps(),
    );
    expect(first.ok).toBe(true);

    // The second device still believes it is on version 1.
    const second = await updateDraftDocument(
      {
        actor,
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/content/couple/brideName', value: 'سارة' }],
      },
      deps(),
    );

    expect(second.ok).toBe(false);
    if (second.ok || second.code !== 'VERSION_CONFLICT') {
      throw new Error(`expected a version conflict, got ${JSON.stringify(second)}`);
    }
    expect(second.currentVersion).toBe(2);
    expect(second.currentDocument).not.toBeNull();

    // The first write survived; nothing was silently overwritten.
    const document = await currentDocument();
    const content = document['content'] as Record<string, Record<string, unknown>>;
    expect(content['couple']?.['groomName']).toBe('أحمد');
    expect(content['couple']?.['brideName']).toBe('');
  });

  it('reports no contended paths when the two edits are disjoint', async () => {
    // This is what lets the client merge silently — the common case of one
    // person on a phone and a laptop.
    const actor = actorFor(ownerId, [invitationId]);

    await updateDraftDocument(
      {
        actor,
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/theme/colors/primary', value: '#000000' }],
      },
      deps(),
    );

    const stale = await updateDraftDocument(
      {
        actor,
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'add', path: '/content/gallery/-', value: { id: 'g1' } }],
      },
      deps(),
    );

    expect(stale.ok).toBe(false);
    if (stale.ok || stale.code !== 'VERSION_CONFLICT') throw new Error('expected a conflict');
    // `/content/gallery/-` does not exist in the server document, so nothing
    // is reported as contended and the client may rebase without asking.
    expect(stale.conflictingPaths).toEqual([]);
  });

  it('names the contended path when both edited the same field', async () => {
    const actor = actorFor(ownerId, [invitationId]);

    await updateDraftDocument(
      {
        actor,
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/content/couple/groomName', value: 'محمد' }],
      },
      deps(),
    );

    const stale = await updateDraftDocument(
      {
        actor,
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/content/couple/groomName', value: 'أحمد' }],
      },
      deps(),
    );

    expect(stale.ok).toBe(false);
    if (stale.ok || stale.code !== 'VERSION_CONFLICT') throw new Error('expected a conflict');
    expect(stale.conflictingPaths).toContain('/content/couple/groomName');
  });

  it('serialises concurrent saves so exactly one wins', async () => {
    const actor = actorFor(ownerId, [invitationId]);

    const results = await Promise.all(
      ['أحمد', 'محمد', 'خالد'].map((name) =>
        updateDraftDocument(
          {
            actor,
            invitationId,
            baseVersion: 1,
            patch: [{ op: 'replace', path: '/content/couple/groomName', value: name }],
          },
          deps(),
        ),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);

    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(invitation.draftVersion).toBe(2);
  });

  it('never leaves an audit row for a legitimate save', async () => {
    await updateDraftDocument(
      {
        actor: actorFor(ownerId, [invitationId]),
        invitationId,
        baseVersion: 1,
        patch: [{ op: 'replace', path: '/content/couple/groomName', value: 'أحمد' }],
      },
      deps(),
    );

    expect(await prisma.auditLog.count({ where: { action: 'invitation.patch_rejected' } })).toBe(0);
  });
});
