import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import type { MediaMaintenanceRepository, MediaRepository } from '../ports/media-repository.js';
import type { StorageProvider } from '../ports/storage-provider.js';
import { decideDeletion } from '../domain/media-deletion.js';
import { PENDING_UPLOAD_EXPIRY_HOURS, SOFT_DELETE_GRACE_DAYS } from '../domain/media-status.js';

/**
 * Deleting media, and cleaning up after it (D4.7, D4.8).
 *
 * Deletion is two-phase on purpose. The user's action marks the row deleted and
 * the asset disappears from their library immediately; the bytes survive a
 * grace period. "I deleted the wrong photo" is a far more frequent event than
 * a storage bill mattering, and the recoverable version costs a scheduled job.
 */

export interface DeleteMediaInput {
  readonly actor: Actor;
  readonly mediaId: string;
}

export interface DeleteMediaDeps {
  readonly repository: MediaRepository;
  readonly clock: Clock;
}

export type DeleteMediaResult =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

export async function deleteMedia(
  input: DeleteMediaInput,
  deps: DeleteMediaDeps,
): Promise<DeleteMediaResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'NO_TENANT_SCOPE', message: 'Not permitted' };

  const media = await deps.repository.findById(scope, input.mediaId);
  if (!media) return { ok: false, code: 'NOT_FOUND', message: 'Media not found' };

  const decision = can(input.actor, 'media:delete', {
    kind: 'invitation',
    id: media.invitationId ?? '',
    ownerId: media.ownerId,
  });
  if (!decision.allowed) {
    return { ok: false, code: decision.reason, message: 'Not permitted' };
  }

  // The invariant this whole milestone's deliverable D4.7 exists for: an image
  // in a published invitation is being looked at by guests right now.
  const usage = await deps.repository.usage(scope, media.id);
  const verdict = decideDeletion(usage, media.deletedAt);
  if (!verdict.allowed) {
    return { ok: false, code: verdict.code, message: verdict.message };
  }

  await deps.repository.softDelete(scope, media.id, deps.clock.now());
  return { ok: true };
}

// ── the sweep (D4.8) ───────────────────────────────────────────────────────

export interface SweepDeps {
  readonly repository: MediaMaintenanceRepository;
  readonly storage: StorageProvider;
  readonly clock: Clock;
  /** Bounded per run so one sweep cannot monopolise the worker. */
  readonly batchSize?: number;
}

export interface SweepReport {
  readonly stalePendingRemoved: number;
  readonly purgedAssets: number;
  readonly storageObjectsDeleted: number;
  /** Failures are counted and reported, never thrown — the sweep continues. */
  readonly failures: readonly string[];
}

const DEFAULT_BATCH = 200;

/**
 * Removes abandoned uploads and expired soft deletes.
 *
 * Storage is emptied before the row is dropped, in that order. The reverse
 * loses the only pointer to the object and leaves bytes nobody can find or
 * bill — the drift that §9's daily reconciliation exists to catch, and which
 * is cheaper not to create.
 */
export async function sweepMedia(deps: SweepDeps): Promise<SweepReport> {
  const now = deps.clock.now();
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const failures: string[] = [];
  let storageObjectsDeleted = 0;

  const staleBefore = new Date(now.getTime() - PENDING_UPLOAD_EXPIRY_HOURS * 60 * 60 * 1000);
  const stale = await deps.repository.findStalePendingUploads(staleBefore, batchSize);

  for (const asset of stale) {
    try {
      // The object may never have existed — the browser closed before the PUT.
      // `delete` is idempotent, so no existence check is needed first.
      await deps.storage.delete(asset.storageKey);
      storageObjectsDeleted += 1;
      await deps.repository.hardDelete(asset.id);
    } catch (error) {
      failures.push(`stale ${asset.id}: ${describe(error)}`);
    }
  }

  const purgeBefore = new Date(now.getTime() - SOFT_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const purgeable = await deps.repository.findPurgeableAssets(purgeBefore, batchSize);
  let purgedAssets = 0;

  for (const asset of purgeable) {
    try {
      // Every derivative shares the asset's key prefix, so one call removes
      // the original and all variants without the sweep needing to know which
      // encodings were produced.
      const prefix = asset.storageKey.slice(0, asset.storageKey.lastIndexOf('/') + 1);
      storageObjectsDeleted += await deps.storage.deletePrefix(prefix);
      await deps.repository.hardDelete(asset.id);
      purgedAssets += 1;
    } catch (error) {
      failures.push(`purge ${asset.id}: ${describe(error)}`);
    }
  }

  return {
    stalePendingRemoved: stale.length - failures.filter((f) => f.startsWith('stale')).length,
    purgedAssets,
    storageObjectsDeleted,
    failures,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
