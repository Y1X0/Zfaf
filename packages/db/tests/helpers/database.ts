import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '../../src/client.js';

/**
 * Integration-test harness.
 *
 * Runs against a real PostgreSQL instance rather than a mock, because the
 * behaviour under test — partial unique indexes, check constraints,
 * immutability triggers, transaction isolation — has no meaningful mock. A
 * fake would report success for exactly the cases most likely to be wrong.
 */

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public';

export function testClient(): PrismaClient {
  return createPrismaClient(TEST_DATABASE_URL);
}

/** Deletes all test data, respecting foreign-key order. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      analytics_events, rsvps, events, slug_history, invitation_members,
      invitation_versions, invitations, media_assets,
      entitlement_overrides, subscriptions,
      sessions, oauth_accounts, email_verifications, password_resets,
      audit_logs, users, template_versions, templates, plans, music_tracks
    RESTART IDENTITY CASCADE
  `);
}

export interface SeededTenant {
  userId: string;
  invitationId: string;
  templateVersionId: string;
}

export async function seedTemplate(prisma: PrismaClient): Promise<string> {
  const templateId = randomUUID();
  const versionId = randomUUID();

  await prisma.template.create({
    data: {
      id: templateId,
      key: `tpl-${templateId.slice(0, 8)}`,
      nameI18n: { ar: 'قالب', en: 'Template' },
      descriptionI18n: { ar: '', en: '' },
      category: 'classic',
      status: 'published',
    },
  });

  await prisma.templateVersion.create({
    data: {
      id: versionId,
      templateId,
      version: 1,
      manifest: {},
      manifestChecksum: 'test',
      publishedAt: new Date(),
    },
  });

  return versionId;
}

export async function seedUser(
  prisma: PrismaClient,
  options: { role?: 'customer' | 'support' | 'admin' | 'superadmin' } = {},
): Promise<string> {
  const userId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      email: `user-${userId.slice(0, 8)}@zfaf.test`,
      emailVerifiedAt: new Date(),
      role: options.role ?? 'customer',
      marketCode: 'SA',
    },
  });
  return userId;
}

export async function seedInvitation(
  prisma: PrismaClient,
  input: { ownerId: string; templateVersionId: string; slug?: string | null },
): Promise<string> {
  const invitationId = randomUUID();
  const templateVersion = await prisma.templateVersion.findUniqueOrThrow({
    where: { id: input.templateVersionId },
    select: { templateId: true },
  });

  await prisma.invitation.create({
    data: {
      id: invitationId,
      ownerId: input.ownerId,
      title: 'Test invitation',
      slug: input.slug ?? null,
      templateId: templateVersion.templateId,
      templateVersionId: input.templateVersionId,
      locale: 'ar',
      marketCode: 'SA',
      timezone: 'Asia/Riyadh',
      eventDate: new Date('2026-09-20T00:00:00.000Z'),
      draftDocument: { schemaVersion: 1 },
    },
  });

  await prisma.invitationMember.create({
    data: {
      id: randomUUID(),
      invitationId,
      userId: input.ownerId,
      role: 'owner',
      acceptedAt: new Date(),
    },
  });

  return invitationId;
}

/** Minimal but schema-valid snapshot, for publish tests. */
export function snapshotFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    templateKey: 'classic-luxury',
    templateVersion: 1,
    locale: 'ar',
    timezone: 'Asia/Riyadh',
    theme: {
      colors: {
        primary: '#b8860b',
        secondary: '#1b1b1b',
        accent: '#e8d9a0',
        background: '#fffdf8',
        surface: '#ffffff',
        textPrimary: '#1a1a1a',
        textSecondary: '#4a4a4a',
        overlay: 'rgba(0, 0, 0, 0.5)',
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
      { id: 's1', type: 'hero', variant: 'hero.centeredArch', enabled: true, order: 1, props: {} },
      { id: 's2', type: 'footer', variant: 'footer.ornament', enabled: true, order: 2, props: {} },
    ],
    content: {
      couple: {
        groomName: 'أحمد',
        brideName: 'سارة',
        shortName: null,
        message: null,
        photo: null,
      },
      wedding: { date: '2026-09-20', startTime: '20:00', endTime: null, timezone: 'Asia/Riyadh' },
      location: {
        venueName: null,
        address: null,
        latitude: null,
        longitude: null,
        mapsUrl: null,
      },
      events: [],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
    publishedAt: '2026-08-16T10:00:00.000Z',
    ...overrides,
  };
}
