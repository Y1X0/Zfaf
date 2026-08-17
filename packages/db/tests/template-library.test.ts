import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { syncTemplates } from '../src/template-sync.js';
import { PrismaTemplateCatalog } from '../src/repositories/template.repository.js';
import { resetDatabase, testClient } from './helpers/database.js';

/**
 * The template library, between the files and the database (docs/23 §7).
 *
 * ## The defect this file exists because of
 *
 * `prisma/seed.ts` used to write three template rows of its own: `status:
 * 'draft'`, `manifestChecksum: 'pending-m3'`, and a manifest of
 * `{ schemaVersion, key, version }` — under a comment saying the real manifest
 * would arrive in M3.
 *
 * M3 arrived. Nobody came back. So a freshly seeded database held three
 * templates that were invisible to the catalogue twice over: draft rather than
 * published, and carrying manifests that do not parse. **Nothing failed**,
 * because until this milestone there was no way for a customer to create an
 * invitation and therefore nothing that ever asked for a template.
 *
 * The moment creating one became possible, that state meant a customer signs
 * up, opens the dashboard, and finds an empty list with no way forward. It was
 * found by the journey suite, which is the only test that starts from nothing.
 *
 * So the assertions below are about **presence and honesty**: the shipped
 * library reaches the catalogue, and anything that cannot be trusted is left
 * out rather than half-offered.
 */

let prisma: PrismaClient;

beforeAll(() => {
  prisma = testClient();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('syncing the shipped manifests', () => {
  it('puts the library where a customer can reach it', async () => {
    const report = await syncTemplates(prisma);

    expect(report.refused, JSON.stringify(report.refused)).toEqual([]);
    expect(report.created.length).toBeGreaterThan(0);

    const catalogue = new PrismaTemplateCatalog(prisma);
    const published = await catalogue.listPublished();

    // The assertion the seed defect would have failed: a fresh database offers
    // templates a customer can actually start from.
    expect(published.length).toBe(report.created.length);
    for (const template of published) {
      expect(template.manifest.key.length).toBeGreaterThan(0);
      expect(template.manifest.sections.length).toBeGreaterThan(0);
      expect(template.templateVersionId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('changes nothing on a second run', async () => {
    const first = await syncTemplates(prisma);
    const second = await syncTemplates(prisma);

    // Safe on every deploy, which is the point: a template change ships as a
    // file and takes effect when this runs.
    expect(second.created).toEqual([]);
    expect(second.unchanged.length).toBe(first.created.length);
    expect(second.refused).toEqual([]);
  });

  it('refuses a version whose content changed rather than rewriting it', async () => {
    await syncTemplates(prisma);

    /**
     * Simulates the placeholder the seed used to write: the same key at the
     * same version, holding something else.
     *
     * A rewrite would change history for invitations already in circulation —
     * their published snapshots were checksummed against what this row said at
     * the time (ADR-0005). So it is refused, loudly, and the operator decides.
     */
    const version = await prisma.templateVersion.findFirst({ orderBy: { version: 'asc' } });
    expect(version).not.toBeNull();
    await prisma.templateVersion.update({
      where: { id: version!.id },
      data: { manifestChecksum: 'pending-m3' },
    });

    const report = await syncTemplates(prisma);
    expect(report.refused.length).toBe(1);
    expect(report.refused[0]?.reason).toContain('bump the version');
  });
});

describe('what the catalogue refuses to offer', () => {
  it('hides a template that is not published', async () => {
    await syncTemplates(prisma);
    const catalogue = new PrismaTemplateCatalog(prisma);
    const before = await catalogue.listPublished();

    const first = await prisma.template.findFirst({ orderBy: { sortOrder: 'asc' } });
    await prisma.template.update({ where: { id: first!.id }, data: { status: 'draft' } });

    const after = await catalogue.listPublished();
    expect(after.length).toBe(before.length - 1);
    expect(await catalogue.findPublishedByKey(first!.key)).toBeNull();
  });

  it('skips one unparseable row rather than emptying the whole library', async () => {
    await syncTemplates(prisma);
    const catalogue = new PrismaTemplateCatalog(prisma);
    const before = await catalogue.listPublished();
    expect(before.length).toBeGreaterThan(1);

    // A row can be changed by a migration, a restore, or an operator with
    // database access. Every manifest is re-validated on the way out for
    // exactly that reason.
    const target = before[0]!;
    await prisma.templateVersion.update({
      where: { id: target.templateVersionId },
      data: { manifest: { schemaVersion: 1, key: target.manifest.key, version: 1 } },
    });

    const invalid: string[] = [];
    const after = await new PrismaTemplateCatalog(prisma, (key) =>
      invalid.push(key),
    ).listPublished();

    expect(after.length).toBe(before.length - 1);
    // Silent would be the real failure: the template simply stops being offered
    // and nobody learns that the data is wrong.
    expect(invalid).toEqual([target.manifest.key]);
  });

  it('offers nothing at all on an empty database, and does not throw', async () => {
    // The state the seed defect left behind, asserted directly: no templates is
    // an empty list, not an exception — the dashboard has to render either way.
    const catalogue = new PrismaTemplateCatalog(prisma);
    expect(await catalogue.listPublished()).toEqual([]);
    expect(await catalogue.findPublishedByKey('classic-luxury')).toBeNull();
  });

  it('ignores a published template whose version pointer is null', async () => {
    /**
     * The state `seedBuilder` leaves in the e2e database: a published template
     * row with no `currentVersionId`. It must not appear, and it must not make
     * the second query fail either.
     */
    await prisma.template.create({
      data: {
        id: randomUUID(),
        key: `dangling-${randomUUID().slice(0, 8)}`,
        nameI18n: { ar: '', en: '' },
        descriptionI18n: { ar: '', en: '' },
        category: 'classic',
        status: 'published',
      },
    });

    expect(await new PrismaTemplateCatalog(prisma).listPublished()).toEqual([]);
  });
});
