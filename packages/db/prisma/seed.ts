import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

/**
 * Development seed.
 *
 * Creates the minimum needed to exercise the system locally: the free plan,
 * reserved slugs, and a verified user. Templates are seeded as records only —
 * the manifests and the renderer arrive in M3, so the rows here carry the
 * identity and version pinning that M1 owns, not the visual definition.
 */

const prisma = new PrismaClient();

// Mirrors the domain list in packages/core/src/invitation/domain/slug.ts. Kept
// in the database too so the set can grow without a deploy (ADR-0013).
const RESERVED_SLUGS: ReadonlyArray<readonly [string, string]> = [
  ['api', 'platform route'],
  ['admin', 'platform route'],
  ['dashboard', 'platform route'],
  ['builder', 'platform route'],
  ['login', 'platform route'],
  ['register', 'platform route'],
  ['settings', 'platform route'],
  ['pricing', 'platform route'],
  ['templates', 'platform route'],
  ['terms', 'legal page'],
  ['privacy', 'legal page'],
  ['i', 'invitation namespace'],
  ['rsvp', 'invitation namespace'],
  ['www', 'infrastructure hostname'],
  ['cdn', 'infrastructure hostname'],
  ['mail', 'infrastructure hostname'],
  ['null', 'reads as a bug in a URL'],
  ['undefined', 'reads as a bug in a URL'],
];

const TEMPLATES: ReadonlyArray<{
  key: string;
  name: { ar: string; en: string };
  category: string;
  planLevel: number;
}> = [
  {
    key: 'classic-luxury',
    name: { ar: 'الفخامة الكلاسيكية', en: 'Classic Luxury' },
    category: 'classic',
    planLevel: 0,
  },
  {
    key: 'royal-gold',
    name: { ar: 'الملكي الذهبي', en: 'Royal Gold' },
    category: 'classic',
    planLevel: 1,
  },
  // Deliberately unlike the other two. It is the health check for the template
  // engine in M3: if it needs renderer changes, the design is wrong (ADR-0004).
  {
    key: 'minimal-white',
    name: { ar: 'الأبيض البسيط', en: 'Minimal White' },
    category: 'minimal',
    planLevel: 0,
  },
];

async function main(): Promise<void> {
  // The MVP plan. Limits are real rather than unlimited, so the enforcement
  // paths are exercised before they start mattering commercially (ADR-0014).
  await prisma.plan.upsert({
    where: { key: 'free_beta' },
    update: {},
    create: {
      id: randomUUID(),
      key: 'free_beta',
      level: 0,
      nameI18n: { ar: 'تجريبي مجاني', en: 'Free Beta' },
      priceAmount: null,
      currency: null,
      limits: {
        features: ['export.csv', 'invitation.remove_branding'],
        limits: {
          'invitation.active': 3,
          'media.gallery_images': 20,
          'media.storage_mb': 200,
          'invitation.active_days_after_event': 30,
          'team.member_count': 1,
        },
      },
      isActive: true,
    },
  });

  for (const [slug, reason] of RESERVED_SLUGS) {
    await prisma.reservedSlug.upsert({
      where: { slug },
      update: { reason },
      create: { slug, reason },
    });
  }

  for (const [index, template] of TEMPLATES.entries()) {
    const existing = await prisma.template.findUnique({ where: { key: template.key } });
    if (existing) continue;

    const templateId = randomUUID();
    const versionId = randomUUID();

    await prisma.template.create({
      data: {
        id: templateId,
        key: template.key,
        nameI18n: template.name,
        descriptionI18n: { ar: '', en: '' },
        category: template.category,
        requiredPlanLevel: template.planLevel,
        status: 'draft', // Published in M3, once a manifest exists.
        sortOrder: index,
      },
    });

    await prisma.templateVersion.create({
      data: {
        id: versionId,
        templateId,
        version: 1,
        // The real manifest lands in M3; this is the version row invitations pin to.
        manifest: { schemaVersion: 1, key: template.key, version: 1 },
        manifestChecksum: 'pending-m3',
      },
    });

    await prisma.template.update({
      where: { id: templateId },
      data: { currentVersionId: versionId },
    });
  }

  const devEmail = 'dev@zfaf.test';
  await prisma.user.upsert({
    where: { email: devEmail },
    update: {},
    create: {
      id: randomUUID(),
      email: devEmail,
      emailVerifiedAt: new Date(),
      name: 'Dev User',
      locale: 'ar',
      marketCode: 'SA',
      role: 'customer',
    },
  });

  console.warn('[seed] plans, reserved slugs, templates and a dev user are in place');
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
