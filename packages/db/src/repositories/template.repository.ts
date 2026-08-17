import type { PrismaClient } from '@prisma/client';

import { type PublishedTemplate, type TemplateCatalog, parseManifest } from '@zfaf/core';

/**
 * Reading the published template library.
 *
 * Every manifest is re-validated on the way out rather than trusted because it
 * is ours. A row can be changed by a migration, a restore, or an operator with
 * database access, and a malformed manifest reaching the builder would surface
 * as a broken invitation rather than as the data problem it is. Parsing here
 * turns that into a template that is simply not offered, and says so through
 * `onInvalid`.
 *
 * A template whose manifest fails to parse is **skipped, not thrown on**: one
 * bad row must not empty the whole library.
 *
 * `currentVersionId` is a plain column rather than a relation, so the version
 * is fetched in a second query and joined here. One extra round trip for a
 * library of three templates, and the alternative is a schema change to a
 * table that invitations pin to for life.
 */
export class PrismaTemplateCatalog implements TemplateCatalog {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly onInvalid: (key: string, errors: unknown) => void = () => {},
  ) {}

  async listPublished(): Promise<readonly PublishedTemplate[]> {
    const templates = await this.prisma.template.findMany({
      where: { status: 'published', currentVersionId: { not: null } },
      orderBy: { sortOrder: 'asc' },
      select: { key: true, currentVersionId: true },
    });
    if (templates.length === 0) return [];

    const versions = await this.prisma.templateVersion.findMany({
      where: { id: { in: templates.map((template) => template.currentVersionId!) } },
      select: { id: true, manifest: true },
    });
    const byId = new Map(versions.map((version) => [version.id, version]));

    const published: PublishedTemplate[] = [];
    for (const template of templates) {
      const version = byId.get(template.currentVersionId!);
      if (!version) continue;

      const parsed = parseManifest(version.manifest);
      if (!parsed.ok) {
        this.onInvalid(template.key, parsed.errors);
        continue;
      }
      published.push({ templateVersionId: version.id, manifest: parsed.manifest });
    }
    return published;
  }

  async findPublishedByKey(key: string): Promise<PublishedTemplate | null> {
    const template = await this.prisma.template.findFirst({
      where: { key, status: 'published' },
      select: { key: true, currentVersionId: true },
    });
    if (!template?.currentVersionId) return null;

    const version = await this.prisma.templateVersion.findUnique({
      where: { id: template.currentVersionId },
      select: { id: true, manifest: true },
    });
    if (!version) return null;

    const parsed = parseManifest(version.manifest);
    if (!parsed.ok) {
      this.onInvalid(template.key, parsed.errors);
      return null;
    }
    return { templateVersionId: version.id, manifest: parsed.manifest };
  }
}
