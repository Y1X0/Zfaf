import { getEnv } from '@zfaf/config';
// Type-only, so it is erased and the native modules are still loaded lazily
// below. The alternative — an `import()` type annotation — is what the
// codebase's import rules forbid.
import type * as MediaProcessing from '@zfaf/media-processing';
import { NO_OP_SCANNER } from '@zfaf/core';
import { PrismaMediaProcessingRepository, getPrismaClient } from '@zfaf/db';

import { container } from './container.js';
import { enqueueMediaProcessing } from './media-queue.js';

/**
 * Where a completed upload goes to be encoded (ADR-0023).
 *
 * Two adapters behind one call, chosen by configuration:
 *
 *   • `queue`  — a BullMQ job for `apps/worker`. The original topology
 *     (docs/08 §6), the default, and unchanged.
 *   • `inline` — `processMediaJob` in this very process, in the request that
 *     completed the upload. What a zero-cost launch costs, because no platform
 *     offers a free always-on worker.
 *
 * Neither is a fallback for the other. A deployment picks one, and picking is
 * a configuration value rather than a code change precisely so that going back
 * is a redeploy rather than a rewrite.
 */

/**
 * Why the import is dynamic.
 *
 * `@zfaf/media-processing` pulls in Sharp and libheif — two native modules
 * weighing tens of megabytes. A static import would load them into every
 * request handler that reaches this module, including a `queue` deployment
 * that will never encode anything. Loaded on first use instead, and cached by
 * the module system afterwards, so only an `inline` deployment ever pays.
 */
let processorPromise: Promise<typeof MediaProcessing> | null = null;

async function processor(): Promise<typeof MediaProcessing> {
  processorPromise ??= import('@zfaf/media-processing');
  return processorPromise;
}

/**
 * Encodes now, in this request.
 *
 * The failure policy is the interesting part, and it is deliberately *not* the
 * queue's. `processMediaJob` throws on a transient failure so BullMQ can retry
 * with backoff; there is no BullMQ here, so a throw would surface as a 500 on
 * a `complete` call whose real work — recording the upload — already
 * succeeded. The asset stays in `processing`, which is true, and
 * `redriveStuckMedia` picks it up on the next sweep (ADR-0023 §4).
 *
 * So the error is logged and swallowed, and that is only defensible *because*
 * the redrive exists. Without it this line would be how a photograph
 * disappears in silence.
 */
async function processInline(mediaId: string): Promise<void> {
  const deps = container();
  const logger = deps.logger;
  const startTime = performance.now();

  logger.debug('media.inline.start', { mediaId });

  const { processMediaJob, SharpImageProcessor } = await processor();
  logger.debug('media.inline.processor_loaded', {
    mediaId,
    elapsedMs: Math.round(performance.now() - startTime),
  });

  try {
    const outcome = await processMediaJob(
      { mediaId },
      {
        repository: new PrismaMediaProcessingRepository(getPrismaClient()),
        storage: deps.storage,
        processor: new SharpImageProcessor(),
        // The same scanner the worker uses: re-encoding already destroys an
        // embedded payload, and a real scanner arrives with audio (docs/10 §7).
        scanner: NO_OP_SCANNER,
      },
    );

    logger.info('media.inline.complete', {
      mediaId,
      result: outcome.result,
      detail: outcome.detail ?? null,
      elapsedMs: Math.round(performance.now() - startTime),
    });

    if (outcome.result === 'quarantined') {
      logger.warn('media.quarantined', { mediaId, detail: outcome.detail ?? '' });
    }
  } catch (error) {
    // Transient. The row is still `processing` and the redrive will return.
    const durationMs = Math.round(performance.now() - startTime);
    logger.error('media.inline_failed', {
      mediaId,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: durationMs,
    });
    deps.errors.capture({ error, event: 'media.inline_failed', fields: { mediaId } });
  }
}

/**
 * Hands one completed upload to whichever adapter this deployment configured.
 *
 * Callers pass only a media id. Which path runs is not a caller's decision —
 * a route that chose for itself would be a second place for the two
 * deployments to drift apart.
 */
export async function dispatchMediaProcessing(mediaId: string): Promise<void> {
  const env = getEnv();
  if (env.MEDIA_DISPATCH === 'inline') {
    await processInline(mediaId);
    return;
  }
  await enqueueMediaProcessing(env.REDIS_URL, mediaId);
}
