import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { syncTemplates } from '../src/template-sync.js';

/**
 * Development seed.
 *
 * Creates the minimum needed to exercise the system locally: the free plan,
 * reserved slugs, a verified user — and **the real template library**.
 *
 * ## Why the templates come from `syncTemplates`
 *
 * This file used to write three template rows of its own, `status: 'draft'`,
 * with `manifest: { schemaVersion, key, version }` and
 * `manifestChecksum: 'pending-m3'`, under a comment saying the real manifest
 * would land in M3.
 *
 * M3 landed. Nobody came back here. So a freshly seeded database held three
 * templates that were **draft** (invisible to the catalogue, which only offers
 * published ones) carrying manifests that **do not parse** (so the catalogue
 * would skip them even if they were published). Nothing failed: there was no
 * way to create an invitation at all, so nothing ever asked for a template.
 *
 * Now that a customer can create one, the same state means a signed-up
 * customer opens the dashboard, finds an empty template list, and cannot start.
 * The seed reads the shipped manifests instead — the same code path a deploy
 * uses — so "the library is present" is true by construction rather than by
 * somebody remembering a second command.
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

  /**
   * The shipped template library, from the manifests themselves.
   *
   * Idempotent, and it refuses rather than rewrites: an existing version whose
   * content changed is reported, not overwritten, because invitations pin to
   * that row for life (ADR-0005). A database seeded before this change carries
   * the old `pending-m3` placeholder at version 1 and will be refused here —
   * correctly. Those rows have to be removed deliberately, by someone who has
   * checked that no invitation pins to them; a seed script must not decide that.
   */
  const templates = await syncTemplates(prisma);
  for (const refusal of templates.refused) {
    console.error(`[seed] template refused — ${refusal.key}: ${refusal.reason}`);
  }
  if (templates.refused.length > 0) {
    process.exitCode = 1;
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

  console.warn(
    `[seed] plans, reserved slugs, a dev user and ${
      templates.created.length + templates.unchanged.length + templates.updated.length
    } published template(s) are in place`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
