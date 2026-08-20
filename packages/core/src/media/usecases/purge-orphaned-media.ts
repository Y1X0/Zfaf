import type { Clock } from '../../ports/clock.js';
import type { MediaMaintenanceRepository } from '../ports/media-repository.js';
import type { StorageProvider } from '../ports/storage-provider.js';

export interface PurgeOrphanedMediaDeps {
  readonly repository: MediaMaintenanceRepository;
  readonly storage: StorageProvider;
  readonly clock: Clock;
}

export interface PurgeMediaReport {
  readonly examined: number;
  readonly deletedFromStorage: number;
  readonly deletedFromDatabase: number;
  readonly storageBytesFreed: number;
  readonly failed: number;
  readonly remaining: number;
}

export async function purgeOrphanedMedia(
  deps: PurgeOrphanedMediaDeps,
  ageThresholdDays: number = 7,
): Promise<PurgeMediaReport> {
  const now = deps.clock.now();
  const olderThan = new Date(now.getTime() - ageThresholdDays * 24 * 60 * 60 * 1000);

  const examinedIds = new Set<string>();
  let deletedFromStorage = 0;
  let deletedFromDatabase = 0;
  let storageBytesFreed = 0;
  let failed = 0;
  let remaining = 0;

  // Process in batches to avoid holding too much in memory at once.
  const batchSize = 100;
  const maxIterations = 1000; // Backstop: ~100k items max per run
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration += 1;
    const batch = await deps.repository.findOrphanedMedia(olderThan, batchSize);
    if (batch.length === 0) break;

    let deletedInBatch = 0;

    for (const asset of batch) {
      examinedIds.add(asset.id);

      try {
        await deps.storage.delete(asset.storageKey);
        deletedFromStorage += 1;
        await deps.repository.hardDelete(asset.id);
        deletedFromDatabase += 1;
        deletedInBatch += 1;
        storageBytesFreed += asset.sizeBytes;
      } catch (error) {
        // S3/B2 DeleteObject is idempotent (204 on missing key). If we get
        // NoSuchKey error, the object is already gone—still delete the row.
        if (isNotFoundError(error)) {
          try {
            await deps.repository.hardDelete(asset.id);
            deletedFromDatabase += 1;
            deletedInBatch += 1;
            storageBytesFreed += asset.sizeBytes;
          } catch {
            failed += 1;
          }
        } else {
          failed += 1;
        }
      }
    }

    // Terminate if no progress in this batch. Prevents infinite loop when all
    // deletes fail (e.g., expired credentials, network partition).
    if (deletedInBatch === 0) {
      remaining = batch.length;
      break;
    }
  }

  return {
    examined: examinedIds.size,
    deletedFromStorage,
    deletedFromDatabase,
    storageBytesFreed,
    failed,
    remaining,
  };
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // AWS SDK v3 S3 error
  if (error.name === 'NoSuchKey') return true;
  // B2 or other storage providers may have httpStatusCode in metadata
  if ('$metadata' in error && typeof error.$metadata === 'object' && error.$metadata !== null) {
    return (error.$metadata as Record<string, unknown>)['httpStatusCode'] === 404;
  }
  return false;
}
