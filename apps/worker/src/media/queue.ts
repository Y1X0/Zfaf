import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

import {
  type ProcessMediaDeps,
  type ProcessMediaJobData,
  type ProcessMediaOutcome,
  processMediaJob,
} from './process-media-job.js';

/**
 * Queue wiring for media processing (D4.3).
 *
 * The retry policy is the interesting part. Three attempts with exponential
 * backoff covers the failures worth retrying — a restarted worker, a momentary
 * storage error — without turning a permanently broken input into an infinite
 * loop. `processMediaJob` never throws for a bad *file*, only for a bad *run*,
 * so nothing hostile ever reaches this policy in the first place.
 *
 * Completed jobs are kept briefly and failed ones for a week: a failure that
 * nobody can inspect afterwards is a failure nobody will fix.
 */

export const MEDIA_QUEUE_NAME = 'media:process';

export const MEDIA_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

export function createMediaQueue(connection: ConnectionOptions): Queue<ProcessMediaJobData> {
  return new Queue<ProcessMediaJobData>(MEDIA_QUEUE_NAME, {
    connection,
    defaultJobOptions: MEDIA_JOB_OPTIONS,
  });
}

/**
 * Enqueues one media asset for processing.
 *
 * The media id is the job id, which makes the queue idempotent: two
 * `complete` calls for the same upload produce one job, not two workers
 * racing to write the same derivatives.
 */
export async function enqueueMediaProcessing(
  queue: Queue<ProcessMediaJobData>,
  mediaId: string,
): Promise<void> {
  await queue.add(MEDIA_QUEUE_NAME, { mediaId }, { jobId: `media:${mediaId}` });
}

export interface MediaWorkerOptions {
  readonly connection: ConnectionOptions;
  readonly deps: ProcessMediaDeps;
  /**
   * Image encoding is CPU-bound, so concurrency above the core count only adds
   * context switching. Two is a safe default for the small instances the
   * worker runs on (docs/08-backend-architecture.md §6).
   */
  readonly concurrency?: number;
  readonly onOutcome?: (outcome: ProcessMediaOutcome) => void;
  readonly onFailure?: (jobId: string | undefined, error: Error) => void;
}

export function startMediaWorker(options: MediaWorkerOptions): Worker<ProcessMediaJobData> {
  const worker = new Worker<ProcessMediaJobData, ProcessMediaOutcome>(
    MEDIA_QUEUE_NAME,
    async (job: Job<ProcessMediaJobData>) => {
      const outcome = await processMediaJob(job.data, options.deps);
      options.onOutcome?.(outcome);
      return outcome;
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 2,
      // A stalled job is one whose worker died mid-encode. Reclaiming it once
      // is right; reclaiming it forever means a job that reliably kills its
      // worker would cycle through the whole pool.
      maxStalledCount: 1,
      // Encoding three sizes in three formats takes real time on a large
      // photo, and a lock that expires mid-run causes a duplicate execution.
      lockDuration: 120_000,
    },
  );

  worker.on('failed', (job, error) => {
    options.onFailure?.(job?.id, error);
  });

  return worker;
}
