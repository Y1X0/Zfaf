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

  const media = await deps.repository.findOrphanedMedia(olderThan, 100);

  let deletedFromStorage = 0;
  let storageBytesFreed = 0;
  let failed = 0;

  for (const asset of media) {
    try {
      await deps.storage.delete(asset.storageKey);
      await deps.repository.hardDelete(asset.id);
      deletedFromStorage += 1;
      storageBytesFreed += asset.sizeBytes;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        await deps.repository.hardDelete(asset.id);
        deletedFromStorage += 1;
        storageBytesFreed += asset.sizeBytes;
      } else {
        failed += 1;
      }
    }
  }

  return {
    examined: media.length,
    deletedFromStorage,
    deletedFromDatabase: deletedFromStorage,
    storageBytesFreed,
    failed,
  };
}
