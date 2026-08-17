import { Worker } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { Queue } from 'bullmq';

import { MEDIA_QUEUE_NAME, enqueueMediaProcessing } from './queue.js';

/**
 * The names BullMQ will accept.
 *
 * This file exists because of a failure that every other test missed. The
 * queue was called `media:process` and jobs `media:<id>`, and BullMQ 6 refuses
 * a colon in either — it builds every Redis key as `{prefix}:{queue}:{...}`,
 * so a colon inside a name makes the key ambiguous. `new Worker()` threw at
 * construction and the worker process exited on boot; `queue.add()` would have
 * thrown on every completed upload.
 *
 * Neither showed up in a unit test, because the unit tests exercised the job
 * *handler* with a stub queue and never constructed the real one. It surfaced
 * the first time the container ran. So this asserts the rule against BullMQ
 * itself rather than against a copy of it written here.
 */

describe('the queue and job names BullMQ will accept', () => {
  it('constructs a real Worker with our queue name', async () => {
    /**
     * The name is validated synchronously in the constructor, before any
     * connection is attempted — which is exactly why this can be a unit test
     * and still be the thing that failed in production. The port is one no
     * Redis listens on, and the worker is closed immediately.
     */
    const worker = new Worker(MEDIA_QUEUE_NAME, async () => undefined, {
      connection: { host: '127.0.0.1', port: 6399, maxRetriesPerRequest: null, lazyConnect: true },
      autorun: false,
    });
    // Nothing is meant to connect; a connection error here is noise, not a
    // finding, and an unhandled one would fail the run for the wrong reason.
    worker.on('error', () => {});

    expect(MEDIA_QUEUE_NAME).not.toContain(':');
    await worker.close(true);
  });

  it('gives a job an id BullMQ will accept', async () => {
    const added: { name: string; options: { jobId?: string } }[] = [];
    const queue = {
      add: async (name: string, _data: unknown, options: { jobId?: string }) => {
        added.push({ name, options });
      },
    } as unknown as Queue<{ mediaId: string }>;

    await enqueueMediaProcessing(queue, 'media-01HXYZ');

    expect(added).toHaveLength(1);
    // `Custom Id cannot contain :` — the same rule, enforced in `Job.addJob`
    // rather than in the constructor, so it would have fired at upload time.
    expect(added[0]!.options.jobId).not.toContain(':');
    // Still derived from the media id, because that is what makes the enqueue
    // idempotent: two `complete` calls for one upload produce one job.
    expect(added[0]!.options.jobId).toContain('media-01HXYZ');
  });
});
