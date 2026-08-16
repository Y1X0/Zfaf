/**
 * Deleting a media asset (D4.7).
 *
 * The rule this module exists for: **an asset referenced by a published
 * snapshot cannot be deleted.** Without it, an owner tidying their library
 * three weeks after sending the link silently breaks the invitation that three
 * hundred guests are still opening — and nothing in the interface would have
 * warned them (docs/10-storage-and-media.md §9).
 *
 * This is a domain invariant, not a UI courtesy. It is enforced here, checked
 * against the database in `deleteMedia`, and covered by an integration test
 * that publishes a real snapshot and then attempts the delete.
 *
 * A published snapshot is immutable (ADR-0005), so "rewrite the snapshot to
 * drop the reference" is not an option by construction. That is the design
 * working, not a limitation to route around.
 */

export interface MediaUsage {
  /** Snapshot versions that reference this asset and are currently published. */
  readonly publishedVersionIds: readonly string[];
  /** Draft references. These do not block deletion — a draft can be edited. */
  readonly draftReferenceCount: number;
}

export type DeletionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: DeletionRefusal; readonly message: string };

export type DeletionRefusal = 'USED_IN_PUBLISHED_INVITATION' | 'ALREADY_DELETED';

export function decideDeletion(usage: MediaUsage, alreadyDeletedAt: Date | null): DeletionDecision {
  if (alreadyDeletedAt) {
    return {
      allowed: false,
      code: 'ALREADY_DELETED',
      message: 'This media has already been deleted',
    };
  }

  if (usage.publishedVersionIds.length > 0) {
    return {
      allowed: false,
      code: 'USED_IN_PUBLISHED_INVITATION',
      // Says what to do about it, because "cannot delete" with no way forward
      // is the kind of message that generates a support ticket.
      message:
        usage.publishedVersionIds.length === 1
          ? 'This image is used in a published invitation. Replace it there first, or unpublish the invitation.'
          : `This image is used in ${usage.publishedVersionIds.length} published invitations. Replace it there first, or unpublish them.`,
    };
  }

  return { allowed: true };
}

/**
 * Collects every media id a snapshot references.
 *
 * Walks the snapshot's own shape rather than searching its JSON for anything
 * that looks like an id: a substring match would tie asset lifetime to
 * unrelated text a couple happened to type.
 */
export function mediaIdsInSnapshotContent(content: unknown): readonly string[] {
  if (content === null || typeof content !== 'object') return [];
  const found = new Set<string>();
  const record = content as Record<string, unknown>;

  const takeId = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const id = (value as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.length > 0) found.add(id);
  };

  takeId(record['cover']);

  const couple = record['couple'];
  if (couple !== null && typeof couple === 'object') {
    takeId((couple as Record<string, unknown>)['photo']);
  }

  const gallery = record['gallery'];
  if (Array.isArray(gallery)) {
    for (const image of gallery) takeId(image);
  }

  return [...found];
}
