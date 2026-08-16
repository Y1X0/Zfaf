import { createHash, randomUUID } from 'node:crypto';

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
    await prisma.invitationMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.invitationVersion.deleteMany({
      where: { invitation: { ownerId: { in: userIds } } },
    });
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
