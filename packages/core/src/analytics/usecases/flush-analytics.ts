import type { AnalyticsBuffer, AnalyticsRepository } from '../ports/analytics-ports.js';

/**
 * Draining the buffer into the database (D8.3).
 *
 * Runs on a timer, every sixty seconds. The interval is the whole design: a
 * wedding link is opened by a WhatsApp group of two hundred people within a
 * couple of minutes of each other, and a row-per-view write pattern puts that
 * burst directly onto the primary at the moment the public page most needs it
 * to be fast. Batching turns two hundred inserts into one.
 *
 * What this costs, stated plainly: **up to sixty seconds of views are lost if
 * the process dies.** That is acceptable for a view counter and would not be
 * for anything else — which is exactly why RSVP responses do not go through
 * here. A guest's reply is written synchronously, transactionally, on the
 * request that created it.
 */

/** How many events one call moves. Bounded so a backlog cannot exhaust memory. */
export const FLUSH_BATCH_SIZE = 500;

/** How many batches one run will take before leaving the rest for the next tick. */
export const FLUSH_MAX_BATCHES = 20;

export interface FlushReport {
  readonly written: number;
  readonly batches: number;
  /** Events still waiting. Non-zero means the next tick has work — not an error. */
  readonly remaining: number;
  readonly failures: readonly string[];
}

export interface FlushAnalyticsDeps {
  readonly buffer: AnalyticsBuffer;
  readonly repository: AnalyticsRepository;
}

export async function flushAnalytics(deps: FlushAnalyticsDeps): Promise<FlushReport> {
  let written = 0;
  let batches = 0;
  const failures: string[] = [];

  for (let index = 0; index < FLUSH_MAX_BATCHES; index += 1) {
    let batch: readonly Awaited<ReturnType<AnalyticsBuffer['drain']>>[number][];
    try {
      batch = await deps.buffer.drain(FLUSH_BATCH_SIZE);
    } catch (error) {
      failures.push(`drain failed: ${message(error)}`);
      break;
    }

    if (batch.length === 0) break;
    batches += 1;

    try {
      written += await deps.repository.recordBatch(batch);
    } catch (error) {
      /**
       * The batch is already out of the buffer, so it is lost.
       *
       * Putting it back would be worse than losing it: a write that fails
       * because of its *content* would be pushed and re-drained forever,
       * blocking every good event behind it. A view counter is not worth a
       * poison-pill loop — but the loss is reported rather than swallowed.
       */
      failures.push(`write of ${batch.length} event(s) failed: ${message(error)}`);
    }
  }

  let remaining = 0;
  try {
    remaining = await deps.buffer.size();
  } catch {
    // Reporting the depth is a nicety; failing the flush over it is not.
  }

  return { written, batches, remaining, failures };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
