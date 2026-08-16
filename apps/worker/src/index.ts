import type { Worker } from 'bullmq';

import { NO_OP_SCANNER, sweepMedia, systemClock } from '@zfaf/core';
import { type Env, getEnv } from '@zfaf/config';
import {
  PrismaMediaMaintenanceRepository,
  PrismaMediaProcessingRepository,
  getPrismaClient,
} from '@zfaf/db';
import { S3StorageProvider } from '@zfaf/infra';

import { SharpImageProcessor } from './media/sharp-image-processor.js';
import { startMediaWorker } from './media/queue.js';

/**
 * The background worker process.
 *
 * Separate from the web app from day one so image encoding never shares a
 * request budget with page rendering, and so the two scale independently
 * (docs/08-backend-architecture.md §6).
 *
 * Shutdown is graceful on purpose: a `SIGTERM` during a deploy must let an
 * in-flight encode finish rather than leave a media asset stuck in
 * `processing` for another worker to reclaim as stalled.
 */

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function buildStorage(env: Env) {
  return new S3StorageProvider({
    driver: env.STORAGE_DRIVER,
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    bucket: env.STORAGE_BUCKET_MEDIA,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    // MinIO addresses buckets by path; R2 and S3 by virtual host.
    forcePathStyle: env.STORAGE_DRIVER === 'minio',
  });
}

function start(): void {
  const env = getEnv();
  const prisma = getPrismaClient();
  const storage = buildStorage(env);
  const connection = { url: env.REDIS_URL };

  const worker = startMediaWorker({
    connection,
    deps: {
      repository: new PrismaMediaProcessingRepository(prisma),
      storage,
      processor: new SharpImageProcessor(),
      // Re-encoding already destroys embedded payloads in images; Phase 2 adds
      // a real scanner when audio uploads arrive (docs/10 §7).
      scanner: NO_OP_SCANNER,
    },
    onOutcome: (outcome) => {
      if (outcome.result === 'quarantined') {
        console.warn(`[worker] quarantined ${outcome.mediaId}: ${outcome.detail ?? ''}`);
      }
    },
    onFailure: (jobId, error) => {
      console.error(`[worker] job ${jobId ?? 'unknown'} failed: ${error.message}`);
    },
  });

  const sweep = setInterval(() => {
    void runSweep(storage, prisma);
  }, SWEEP_INTERVAL_MS);

  console.warn(`[worker] started; media queue running against ${storage.key}`);

  registerShutdown(worker, sweep, prisma);
}

/** The garbage collection pass (D4.8). Never throws — a failed run is reported. */
async function runSweep(
  storage: ReturnType<typeof buildStorage>,
  prisma: ReturnType<typeof getPrismaClient>,
): Promise<void> {
  try {
    const report = await sweepMedia({
      repository: new PrismaMediaMaintenanceRepository(prisma),
      storage,
      clock: systemClock,
    });

    if (report.stalePendingRemoved > 0 || report.purgedAssets > 0) {
      console.warn(
        `[worker] sweep removed ${report.stalePendingRemoved} abandoned upload(s) and purged ${report.purgedAssets} asset(s)`,
      );
    }
    // Silent truncation would read as "nothing to clean" when the batch was
    // simply full, so failures are always surfaced.
    for (const failure of report.failures) {
      console.error(`[worker] sweep failure: ${failure}`);
    }
  } catch (error) {
    console.error(`[worker] sweep aborted: ${error instanceof Error ? error.message : error}`);
  }
}

function registerShutdown(
  worker: Worker,
  sweep: NodeJS.Timeout,
  prisma: ReturnType<typeof getPrismaClient>,
): void {
  let shuttingDown = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.warn(`[worker] received ${signal}, finishing in-flight jobs`);

      clearInterval(sweep);
      // `close()` waits for active jobs. Killing the process instead leaves an
      // asset in `processing` until another worker reclaims it as stalled.
      void worker
        .close()
        .then(() => prisma.$disconnect())
        .finally(() => process.exit(0));
    });
  }
}

start();
