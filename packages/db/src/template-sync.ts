import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';

import { parseManifest, snapshotChecksum } from '@zfaf/core';

/**
 * Puts the shipped template manifests into the database (docs/23 §7).
 *
 * The library exists twice by necessity: as files under
 * `packages/invitation-renderer/templates/`, which is where a designer edits
 * them and where `template:validate` checks them, and as rows an invitation can
 * pin a version to for the rest of its life (ADR-0005). This is what carries
 * the first into the second.
 *
 * Without it there is no template to create an invitation from, and the whole
 * builder is unreachable for a new customer — which is exactly the state
 * docs/23 found the product in: the seed created template rows with a
 * placeholder manifest and a comment saying the real one lands later.
 *
 * ## The rules it follows
 *
 * **Idempotent.** Running it twice changes nothing. Safe to run on every
 * deploy, which is the point — a template change ships as a file and takes
 * effect when this runs.
 *
 * **A new version is a new row.** An existing version is never edited, because
 * invitations point at it and a snapshot's checksum was computed over what it
 * said at the time. A changed manifest at the same version number is refused
 * rather than silently rewritten; bump the version.
 *
 * **Publishing is the last step**, after the version row exists, so a template
 * is never visible pointing at nothing.
 *
 * It lives in `src/` rather than beside the schema because three callers need
 * it: the CLI (`prisma/sync-templates.ts`), the development seed, and the e2e
 * fixtures — a suite that starts from an empty database has to be able to put
 * the library there itself rather than trust that somebody ran a command.
 */

export interface SyncReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  /** A manifest that does not parse, or one that changed without a new version. */
  readonly refused: readonly { key: string; reason: string }[];
}

function templatesDirectory(): string {
  // From `packages/db/src/` to `packages/invitation-renderer/templates/`.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'invitation-renderer', 'templates');
}

function readManifests(directory: string): { key: string; raw: unknown }[] {
  const entries = readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isDirectory());

  const manifests: { key: string; raw: unknown }[] = [];
  for (const entry of entries) {
    const file = join(entry, 'manifest.json');
    try {
      manifests.push({ key: entry.split('/').pop()!, raw: JSON.parse(readFileSync(file, 'utf8')) });
    } catch {
      // A directory without a readable manifest is not a template.
    }
  }
  return manifests;
}

export async function syncTemplates(prisma: PrismaClient): Promise<SyncReport> {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const refused: { key: string; reason: string }[] = [];

  const files = readManifests(templatesDirectory());

  for (const [index, file] of files.entries()) {
    const parsed = parseManifest(file.raw);
    if (!parsed.ok) {
      refused.push({
        key: file.key,
        reason: `manifest is invalid: ${JSON.stringify(parsed.errors)}`,
      });
      continue;
    }
    const manifest = parsed.manifest;
    const checksum = snapshotChecksum(manifest);

    const template = await prisma.template.upsert({
      where: { key: manifest.key },
      update: {
        nameI18n: manifest.meta.name,
        descriptionI18n: manifest.meta.description,
        category: manifest.meta.category,
        previewImageKey: manifest.meta.previewImage,
        requiredPlanLevel: manifest.meta.requiredPlanLevel,
      },
      create: {
        id: randomUUID(),
        key: manifest.key,
        nameI18n: manifest.meta.name,
        descriptionI18n: manifest.meta.description,
        category: manifest.meta.category,
        previewImageKey: manifest.meta.previewImage,
        requiredPlanLevel: manifest.meta.requiredPlanLevel,
        status: 'draft',
        sortOrder: index,
      },
      select: { id: true, currentVersionId: true },
    });

    const existingVersion = await prisma.templateVersion.findFirst({
      where: { templateId: template.id, version: manifest.version },
      select: { id: true, manifestChecksum: true },
    });

    let versionId: string;
    if (!existingVersion) {
      versionId = randomUUID();
      await prisma.templateVersion.create({
        data: {
          id: versionId,
          templateId: template.id,
          version: manifest.version,
          manifest: manifest as object,
          manifestChecksum: checksum,
        },
      });
      created.push(`${manifest.key}@${manifest.version}`);
    } else if (existingVersion.manifestChecksum !== checksum) {
      /**
       * Refused, deliberately.
       *
       * Invitations pin to this row, and published snapshots were checksummed
       * against what it said. Rewriting it in place would change history for
       * invitations already in circulation — a guest's page would quietly
       * stop matching the version it claims to be.
       */
      refused.push({
        key: manifest.key,
        reason: `version ${manifest.version} already exists with different content — bump the version`,
      });
      continue;
    } else {
      versionId = existingVersion.id;
      unchanged.push(`${manifest.key}@${manifest.version}`);
    }

    // Published last, and pointing at a version that certainly exists.
    if (template.currentVersionId !== versionId) {
      await prisma.template.update({
        where: { id: template.id },
        data: { currentVersionId: versionId, status: 'published' },
      });
      if (existingVersion) updated.push(`${manifest.key}@${manifest.version}`);
    } else {
      await prisma.template.update({
        where: { id: template.id },
        data: { status: 'published' },
      });
    }
  }

  return { created, updated, unchanged, refused };
}
