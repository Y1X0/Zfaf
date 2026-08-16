import { createHash, randomUUID } from 'node:crypto';

import { parseDraftDocument, resolveDocument, snapshotChecksum } from '@zfaf/core';
import { getPrismaClient } from '@zfaf/db';

/**
 * Seeds a signed-in user with an invitation, for the end-to-end suite.
 *
 * The session is created the way the application does — a random token stored
 * only as a SHA-256 hash (ADR-0006) — rather than by a test-only bypass. A
 * fixture that logs in through a back door tests a path production does not
 * have, and would keep passing if the real one broke.
 */

export interface SeededBuilder {
  readonly invitationId: string;
  readonly sessionToken: string;
  readonly userId: string;
  readonly draftVersion: number;
}

export interface SeededPublished extends SeededBuilder {
  readonly slug: string;
  readonly versionId: string;
}

export type PublishedStatus = 'PUBLISHED' | 'PAUSED' | 'EXPIRED' | 'SUSPENDED' | 'DRAFT';

const TEST_EMAIL_DOMAIN = 'e2e.zfaf.test';

export function testDatabaseUrl(): string {
  return (
    process.env['DATABASE_URL'] ??
    'postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public'
  );
}

/**
 * Reuses the data layer's own client factory.
 *
 * `packages/db` is the only package permitted to import Prisma (ADR-0003,
 * enforced by `zfaf/no-prisma-outside-db`), and a test fixture is not an
 * exemption from that — it is just another caller.
 */
export function prismaClient(): ReturnType<typeof getPrismaClient> {
  return getPrismaClient(testDatabaseUrl());
}

function draftDocument(timezone: string) {
  return {
    schemaVersion: 1,
    templateKey: 'classic-luxury',
    templateVersion: 1,
    locale: 'ar',
    timezone,
    theme: {
      colors: {
        primary: '#8a6d24',
        secondary: '#2f2a24',
        accent: '#d9c89a',
        background: '#fffdf8',
        surface: '#f7f2e7',
        textPrimary: '#241f1a',
        textSecondary: '#5c5348',
        overlay: 'rgba(36, 31, 26, 0.35)',
      },
      typography: {
        displayFont: 'aref-ruqaa',
        bodyFont: 'ibm-plex-arabic',
        scale: 'normal',
        displayWeight: 400,
      },
      spacing: 'normal',
      radius: 'soft',
      buttons: 'solid',
      dividers: 'ornament',
      background: { kind: 'solid', value: 'ivory', overlayOpacity: 0 },
      motion: { intensity: 'subtle', effects: [] },
      numerals: 'latin',
    },
    sections: [
      {
        id: 'hero',
        type: 'hero',
        variant: 'hero.centeredArch',
        enabled: true,
        order: 0,
        props: {},
      },
      {
        id: 'couple',
        type: 'couple',
        variant: 'couple.portraitPair',
        enabled: true,
        order: 1,
        props: {},
      },
      {
        id: 'gallery',
        type: 'gallery',
        variant: 'gallery.masonry',
        enabled: true,
        order: 2,
        props: {},
      },
      {
        id: 'footer',
        type: 'footer',
        variant: 'footer.ornament',
        enabled: true,
        order: 3,
        props: {},
      },
    ],
    content: {
      couple: { groomName: '', brideName: '', shortName: null, message: null, photo: null },
      wedding: { date: null, startTime: null, endTime: null, timezone },
      location: { venueName: null, address: null, latitude: null, longitude: null, mapsUrl: null },
      events: [],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
  };
}

export async function seedBuilder(): Promise<SeededBuilder> {
  const prisma = prismaClient();
  try {
    // The market decides the zone; hard-coding one here would reintroduce
    // exactly the assumption ADR-0015 removes.
    const timezone = 'UTC';

    const templateId = randomUUID();
    const templateVersionId = randomUUID();
    await prisma.template.create({
      data: {
        id: templateId,
        key: `e2e-${randomUUID().slice(0, 8)}`,
        nameI18n: { ar: 'قالب اختبار', en: 'Test template' },
        descriptionI18n: { ar: '', en: '' },
        category: 'classic',
        status: 'published',
      },
    });
    await prisma.templateVersion.create({
      data: {
        id: templateVersionId,
        templateId,
        version: 1,
        manifest: {},
        manifestChecksum: 'e2e',
        publishedAt: new Date(),
      },
    });

    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `e2e-${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`,
        emailVerifiedAt: new Date(),
        marketCode: 'SA',
        role: 'customer',
      },
    });

    const invitationId = randomUUID();
    await prisma.invitation.create({
      data: {
        id: invitationId,
        ownerId: userId,
        title: 'دعوة اختبار',
        templateId,
        templateVersionId,
        locale: 'ar',
        marketCode: 'SA',
        timezone,
        eventDate: new Date('2026-09-20T00:00:00.000Z'),
        draftDocument: draftDocument(timezone),
      },
    });
    await prisma.invitationMember.create({
      data: {
        id: randomUUID(),
        invitationId,
        userId,
        role: 'owner',
        acceptedAt: new Date(),
      },
    });

    // Stored as a hash only, exactly as the application does.
    const sessionToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await prisma.session.create({
      data: {
        id: randomUUID(),
        userId,
        tokenHash: createHash('sha256').update(sessionToken).digest(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        // `createdAt` bounds the absolute lifetime; the domain derives the cap
        // from it rather than storing a second timestamp.
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
    });

    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    return { invitationId, sessionToken, userId, draftVersion: invitation.draftVersion };
  } finally {
    // The factory caches one client per URL, so it is not disconnected here;
    // the process exiting closes it.
  }
}

/** Removes everything a run created, keyed by the test email domain. */
export async function cleanupSeeded(): Promise<void> {
  const prisma = prismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: TEST_EMAIL_DOMAIN } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    if (userIds.length === 0) return;

    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.slugHistory.deleteMany({ where: { invitation: { ownerId: { in: userIds } } } });
    await prisma.rsvp.deleteMany({ where: { invitation: { ownerId: { in: userIds } } } });
    await prisma.invitationMember.deleteMany({ where: { userId: { in: userIds } } });
    // The pointer has to be cleared before the versions it points at can go —
    // and the status with it, because a check constraint (rightly) refuses a
    // PUBLISHED invitation that points at no version.
    await prisma.invitation.updateMany({
      where: { ownerId: { in: userIds } },
      data: { publishedVersionId: null, status: 'DRAFT' },
    });
    // Versions are not deleted directly: the immutability trigger (M1) refuses
    // that while the invitation exists, and rightly — a published snapshot is
    // append-only. Deleting the invitation cascades them, which is the only
    // route the schema allows and therefore the one a cleanup should take.
    await prisma.invitation.deleteMany({ where: { ownerId: { in: userIds } } });
    // Audit rows are deliberately left behind: the table rejects DELETE by
    // trigger (M1), and an audit log a cleanup routine can erase is not an
    // audit log. They carry no personal data beyond an actor id.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    // The factory caches one client per URL, so it is not disconnected here;
    // the process exiting closes it.
  }
}

export async function readDraft(invitationId: string): Promise<{
  document: Record<string, unknown>;
  version: number;
}> {
  const prisma = prismaClient();
  try {
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    return { document: row.draftDocument as Record<string, unknown>, version: row.draftVersion };
  } finally {
    // The factory caches one client per URL, so it is not disconnected here;
    // the process exiting closes it.
  }
}

/**
 * A complete, filled-in draft — the starting point for publishing.
 *
 * Separate from `draftDocument`, which is deliberately empty because the
 * builder tests need to type into it. Publishing needs a draft that has what
 * an invitation must have, and nothing more.
 */
function filledDraft(timezone: string): Record<string, unknown> {
  const base = draftDocument(timezone) as Record<string, unknown>;

  // A countdown, because it is the one section with client behaviour and the
  // published page's only moving part.
  const sections = base['sections'] as Record<string, unknown>[];
  sections.splice(1, 0, {
    id: 'countdown',
    type: 'countdown',
    variant: 'countdown.ornateBoxes',
    enabled: true,
    order: 1,
    props: {},
  });
  // The RSVP form, which is the whole of M7's public surface.
  sections.splice(2, 0, {
    id: 'rsvp',
    type: 'rsvp',
    variant: 'rsvp.elegantForm',
    enabled: true,
    order: 2,
    props: {},
  });

  const content = base['content'] as Record<string, Record<string, unknown>>;
  content['couple'] = { ...content['couple'], groomName: 'أحمد', brideName: 'سارة' };
  content['wedding'] = { ...content['wedding'], date: '2026-09-20', startTime: '20:00' };
  content['location'] = { ...content['location'], venueName: 'قاعة النخيل' };
  return base;
}

export interface SeedPublishedOptions {
  readonly status?: PublishedStatus;
  readonly visibility?: 'UNLISTED' | 'INDEXED' | 'PROTECTED';
  readonly expiresAt?: Date | null;
  readonly slug?: string;
}

/**
 * Seeds an invitation that has already been published.
 *
 * The snapshot is produced by the same `resolveDocument` the publish use case
 * calls, and checksummed by the same function, so what the public page reads
 * here is what publishing really writes. A fixture that hand-wrote a snapshot
 * would be testing the fixture's idea of one.
 *
 * `status` is settable because the security matrix needs an expired, a paused
 * and a suspended invitation, and there is no legitimate application path that
 * puts an invitation into all three.
 */
export async function seedPublished(options: SeedPublishedOptions = {}): Promise<SeededPublished> {
  const prisma = prismaClient();
  const seeded = await seedBuilder();
  const timezone = 'UTC';

  const draft = filledDraft(timezone);
  const parsed = parseDraftDocument(draft);
  if (!parsed.ok) throw new Error(`seed draft is invalid: ${parsed.errors.join(', ')}`);

  const publishedAt = new Date();
  const resolved = resolveDocument(parsed.document, { publishedAt: publishedAt.toISOString() });
  if (!resolved.ok) {
    throw new Error(
      `seed draft is not publishable: ${resolved.issues.map((i) => i.field).join(', ')}`,
    );
  }

  const invitation = await prisma.invitation.findUniqueOrThrow({
    where: { id: seeded.invitationId },
    select: { templateVersionId: true },
  });

  const versionId = randomUUID();
  await prisma.invitationVersion.create({
    data: {
      id: versionId,
      invitationId: seeded.invitationId,
      versionNumber: 1,
      publishedDocument: resolved.snapshot as unknown as object,
      documentChecksum: snapshotChecksum(resolved.snapshot),
      templateVersionId: invitation.templateVersionId,
      publishedById: seeded.userId,
      publishedAt,
    },
  });

  const slug = options.slug ?? `e2e-${randomUUID().slice(0, 8)}`;
  await prisma.invitation.update({
    where: { id: seeded.invitationId },
    data: {
      draftDocument: draft as object,
      slug,
      status: options.status ?? 'PUBLISHED',
      visibility: options.visibility ?? 'UNLISTED',
      publishedVersionId: versionId,
      publishedAt,
      expiresAt: options.expiresAt ?? null,
    },
  });

  return { ...seeded, slug, versionId };
}

/** Retires a slug the way a rename does, so the 301 can be exercised. */
export async function retireSlug(invitationId: string, oldSlug: string): Promise<void> {
  const prisma = prismaClient();
  await prisma.slugHistory.create({
    data: { id: randomUUID(), invitationId, oldSlug, changedAt: new Date() },
  });
}

/** How many replies an invitation has. Used to assert that nothing was written. */
export async function countRsvps(invitationId: string): Promise<number> {
  return prismaClient().rsvp.count({ where: { invitationId } });
}

/** The invitation's denormalised reply counters (M7). */
export async function readCounters(
  invitationId: string,
): Promise<{ yes: number; no: number; guests: number }> {
  const row = await prismaClient().invitation.findUniqueOrThrow({
    where: { id: invitationId },
    select: { rsvpYesCount: true, rsvpNoCount: true, rsvpGuestCount: true },
  });
  return { yes: row.rsvpYesCount, no: row.rsvpNoCount, guests: row.rsvpGuestCount };
}

/**
 * A signed-in platform administrator.
 *
 * Used to prove the negative: staff reach the invitation and are still refused
 * the guest list, because guest data is not staff-readable however senior the
 * account (docs/09 §3.4).
 */
export async function seedStaffSession(): Promise<{ userId: string; sessionToken: string }> {
  const prisma = prismaClient();
  const userId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      email: `staff-${randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`,
      emailVerifiedAt: new Date(),
      marketCode: 'SA',
      role: 'admin',
    },
  });

  const sessionToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  await prisma.session.create({
    data: {
      id: randomUUID(),
      userId,
      tokenHash: createHash('sha256').update(sessionToken).digest(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      lastUsedAt: new Date(),
    },
  });

  return { userId, sessionToken };
}
