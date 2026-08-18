import type { Worker } from 'bullmq';

import {
  NO_OP_SCANNER,
  expireDueInvitations,
  flushAnalytics,
  sweepMedia,
  systemClock,
} from '@zfaf/core';
import { type Env, getEnv } from '@zfaf/config';
import {
  PrismaAnalyticsRepository,
  PrismaAuditLogRepository,
  PrismaInvitationRepository,
  PrismaMediaMaintenanceRepository,
  PrismaMediaProcessingRepository,
  getPrismaClient,
} from '@zfaf/db';
import { S3StorageProvider } from '@zfaf/infra';
import { RedisAnalyticsBuffer, closeRedis, getRedis } from '@zfaf/infra/analytics';

import { SharpImageProcessor } from '@zfaf/media-processing';
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

/**
 * How often buffered views are written (D8.3).
 *
 * Sixty seconds, as specified. Short enough that a couple refreshing their
 * dashboard sees a view they just generated; long enough that a WhatsApp group
 * of two hundred people opening the link at once becomes one insert instead of
 * two hundred.
 */
const ANALYTICS_FLUSH_INTERVAL_MS = 60 * 1000;

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
    void runExpiry(prisma);
  }, SWEEP_INTERVAL_MS);

  const analyticsBuffer = new RedisAnalyticsBuffer(getRedis(env.REDIS_URL));
  const analytics = new PrismaAnalyticsRepository(prisma);
  const analyticsFlush = setInterval(() => {
    void runAnalyticsFlush(analyticsBuffer, analytics);
  }, ANALYTICS_FLUSH_INTERVAL_MS);

  console.warn(`[worker] started; media queue running against ${storage.key}`);

  registerShutdown(worker, [sweep, analyticsFlush], prisma, analyticsBuffer, analytics);
}

/**
 * The analytics flush (D8.3). Never throws — a failed run is reported and retried.
 *
 * Quiet when there is nothing to do: this fires every minute of every day, and
 * a log line per tick would bury the ones that matter. It speaks only when it
 * wrote something or when something went wrong.
 */
async function runAnalyticsFlush(
  buffer: RedisAnalyticsBuffer,
  repository: PrismaAnalyticsRepository,
): Promise<void> {
  try {
    const report = await flushAnalytics({ buffer, repository });

    for (const failure of report.failures) {
      console.error(`[worker] analytics flush: ${failure}`);
    }
    if (report.remaining > 0) {
      // The buffer is not keeping up, which is worth saying out loud before it
      // reaches its cap and starts dropping views silently.
      console.warn(
        `[worker] analytics flushed ${report.written} event(s); ${report.remaining} still queued`,
      );
    }
  } catch (error) {
    console.error(
      `[worker] analytics flush aborted: ${error instanceof Error ? error.message : error}`,
    );
  }
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

/**
 * The expiry sweep (D6.3).
 *
 * Not what makes expiry correct — the public route already refuses an
 * invitation past its date, so a guest never sees one late. This is what makes
 * the stored *state* honest, so a dashboard, a list and an export all agree
 * with what the public page has been saying since midnight.
 *
 * Runs alongside the media sweep rather than on its own schedule: it is a
 * bounded, idempotent statement, and a second timer would be a second thing to
 * misconfigure.
 */
async function runExpiry(prisma: ReturnType<typeof getPrismaClient>): Promise<void> {
  try {
    const audit = new PrismaAuditLogRepository(prisma);
    const report = await expireDueInvitations({
      repository: new PrismaInvitationRepository(prisma),
      clock: systemClock,
      recordPublication: async (entry) => {
        await audit.record(
          {
            actorId: null,
            actorType: 'system',
            action: 'invitation.expired',
            resourceType: 'invitation',
            resourceId: entry.invitationId,
            metadata: { job: 'expiry-sweep' },
            ipHash: null,
          },
          entry.at,
        );
      },
    });

    if (report.expired > 0) {
      console.warn(`[worker] expired ${report.expired} invitation(s)`);
    }
  } catch (error) {
    console.error(`[worker] expiry aborted: ${error instanceof Error ? error.message : error}`);
  }
}

function registerShutdown(
  worker: Worker,
  timers: readonly NodeJS.Timeout[],
  prisma: ReturnType<typeof getPrismaClient>,
  analyticsBuffer: RedisAnalyticsBuffer,
  analytics: PrismaAnalyticsRepository,
): void {
  let shuttingDown = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.warn(`[worker] received ${signal}, finishing in-flight jobs`);

      for (const timer of timers) clearInterval(timer);
      // `close()` waits for active jobs. Killing the process instead leaves an
      // asset in `processing` until another worker reclaims it as stalled.
      void worker
        .close()
        // One last flush on the way out. A deploy every few minutes would
        // otherwise throw away a minute of views each time, which turns a
        // bounded loss into a systematic one.
        .then(() => runAnalyticsFlush(analyticsBuffer, analytics))
        .then(() => closeRedis())
        .then(() => prisma.$disconnect())
        .finally(() => process.exit(0));
    });
  }
}

start();
