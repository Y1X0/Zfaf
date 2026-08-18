/**
 * The media processing adapter (D4.3, D4.4, ADR-0019).
 *
 * It lives in a package rather than inside `apps/worker` for one reason, and
 * the reason is ADR-0023: there are now two callers. The worker consumes a
 * BullMQ queue and calls this; the web app, when configured for the zero-cost
 * deployment, calls it directly from the request that completed the upload.
 *
 * The boundary that mattered is unchanged, not relaxed. Sharp is still
 * imported by exactly one module and libheif by exactly one, and both rules are
 * still enforced by dependency-cruiser — they simply point here now. Callers
 * receive the `ImageProcessor` port from `@zfaf/core` and never the library.
 */
export { processMediaJob, TransientJobError } from './process-media-job.js';
export type {
  ProcessMediaDeps,
  ProcessMediaJobData,
  ProcessMediaOutcome,
} from './process-media-job.js';
export { SharpImageProcessor } from './sharp-image-processor.js';
