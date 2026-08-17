import type { TemplateManifest } from '../domain/template-manifest.js';

/**
 * Reading the published template library.
 *
 * A template is two things at once: a **manifest** the builder and the
 * renderer read, and a **version row** an invitation pins to for the rest of
 * its life (ADR-0005). Both are needed to start a draft, and neither is useful
 * without the other, so the port hands them over together rather than making
 * the caller join two lookups and hope they agree.
 *
 * Only published templates are visible here. A draft template is one somebody
 * is still working on, and an invitation pinned to it would be pinned to a
 * moving target.
 */

export interface PublishedTemplate {
  /** The row an invitation pins to. Frozen into every snapshot it publishes. */
  readonly templateVersionId: string;
  readonly manifest: TemplateManifest;
}

export interface TemplateCatalog {
  /** Ordered as the library is meant to be shown. */
  listPublished(): Promise<readonly PublishedTemplate[]>;
  findPublishedByKey(key: string): Promise<PublishedTemplate | null>;
}
