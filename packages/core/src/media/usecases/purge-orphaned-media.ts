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
}

export async function purgeOrphanedMedia(
  deps: PurgeOrphanedMediaDeps,
  ageThresholdDays: number = 7,
): Promise<PurgeMediaReport> {
  const now = deps.clock.now();
  const olderThan = new Date(now.getTime() - ageThresholdDays * 24 * 60 * 60 * 1000);

  let examined = 0;
  let deletedFromStorage = 0;
  let deletedFromDatabase = 0;
  let storageBytesFreed = 0;
  let failed = 0;

  // Process in batches to avoid holding too much in memory at once.
  const batchSize = 100;
  let hasMore = true;

  while (hasMore) {
    const batch = await deps.repository.findOrphanedMedia(olderThan, batchSize);
    if (batch.length === 0) break;

    examined += batch.length;

    for (const asset of batch) {
      try {
        await deps.storage.delete(asset.storageKey);
        deletedFromStorage += 1;
        await deps.repository.hardDelete(asset.id);
        deletedFromDatabase += 1;
        storageBytesFreed += asset.sizeBytes;
      } catch (error) {
        // S3/B2 DeleteObject is idempotent (204 on missing key). If we get
        // NoSuchKey error, the object is already gone—still delete the row.
        if (isNotFoundError(error)) {
          try {
            await deps.repository.hardDelete(asset.id);
            deletedFromDatabase += 1;
            storageBytesFreed += asset.sizeBytes;
          } catch {
            failed += 1;
          }
        } else {
          failed += 1;
        }
      }
    }

    // Stop if we got fewer than requested: there are no more.
    hasMore = batch.length === batchSize;
  }

  return {
    examined,
    deletedFromStorage,
    deletedFromDatabase,
    storageBytesFreed,
    failed,
  };
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // AWS SDK v3 S3 error
  if (error.name === 'NoSuchKey') return true;
  // B2 or other storage providers may have httpStatusCode in metadata
  if ('$metadata' in error && typeof error.$metadata === 'object' && error.$metadata !== null) {
    return (error.$metadata as Record<string, unknown>).httpStatusCode === 404;
  }
  return false;
}
