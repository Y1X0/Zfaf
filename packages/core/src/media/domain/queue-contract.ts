/**
 * The names the media queue is addressed by.
 *
 * Two processes need to agree on these and neither may own them: `apps/web`
 * puts a job in when an upload completes, and `apps/worker` takes it out. When
 * the names lived in the worker, the web app had no way to reach them without
 * importing from another application — which the boundary rules forbid, for
 * good reason.
 *
 * They are plain strings, so this file adds no dependency to `packages/core`
 * and stays framework-free. The queue *library* lives in the two applications;
 * only the vocabulary is shared.
 *
 * ## No colons, and that is a constraint
 *
 * BullMQ builds every Redis key as `{prefix}:{queue}:{...}` and refuses a queue
 * name containing `:` outright — `new Worker()` throws at construction, so the
 * worker process exits on boot. The same rule applies to a custom job id. Both
 * were `media:...` until the first container run, where the process died before
 * it could take a job and every completed upload would have thrown.
 */

export const MEDIA_QUEUE_NAME = 'media-process';

/**
 * The job id for a media asset.
 *
 * Derived from the media id so the enqueue is idempotent: two `complete` calls
 * for one upload produce one job, not two workers racing to write the same
 * derivatives.
 */
export function mediaJobId(mediaId: string): string {
  return `media-${mediaId}`;
}

/**
 * Retry policy (D4.3).
 *
 * Three attempts with exponential backoff covers the failures worth retrying —
 * a restarted worker, a momentary storage error — without turning a
 * permanently broken input into an infinite loop. `processMediaJob` never
 * throws for a bad *file*, only for a bad *run*, so nothing hostile ever
 * reaches this policy.
 *
 * Completed jobs are kept briefly and failed ones for a week: a failure nobody
 * can inspect afterwards is a failure nobody will fix.
 */
export const MEDIA_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;
