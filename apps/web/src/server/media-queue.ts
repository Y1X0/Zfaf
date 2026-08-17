import { Queue } from 'bullmq';

import { MEDIA_JOB_OPTIONS, MEDIA_QUEUE_NAME, mediaJobId } from '@zfaf/core';

/**
 * The web app's end of the media queue.
 *
 * `apps/worker` consumes; this produces. Both address the queue through the
 * vocabulary in `@zfaf/core` rather than each spelling the names themselves,
 * because a producer and a consumer that disagree about a queue name is a
 * silence: jobs go somewhere nobody reads, uploads stay `processing` forever,
 * and no error is raised anywhere.
 *
 * Created lazily and once. A `Queue` opens a Redis connection on construction,
 * and building one per request exhausts the connection pool in minutes — the
 * same reason the Prisma client is a module-level singleton.
 */

let queue: Queue<{ mediaId: string }> | null = null;

function mediaQueue(redisUrl: string): Queue<{ mediaId: string }> {
  queue ??= new Queue<{ mediaId: string }>(MEDIA_QUEUE_NAME, {
    connection: { url: redisUrl },
    defaultJobOptions: MEDIA_JOB_OPTIONS,
  });
  return queue;
}

/**
 * Queues one media asset for processing.
 *
 * The job id is derived from the media id, which makes this idempotent: two
 * `complete` calls for the same upload produce one job rather than two workers
 * racing to write the same derivatives.
 */
export async function enqueueMediaProcessing(redisUrl: string, mediaId: string): Promise<void> {
  await mediaQueue(redisUrl).add(MEDIA_QUEUE_NAME, { mediaId }, { jobId: mediaJobId(mediaId) });
}
