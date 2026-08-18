/**
 * Calls Zfaf's scheduled-jobs endpoint on a timer (ADR-0023).
 *
 * The whole Worker is one `fetch` per job, and that is the design rather than
 * a stub. The jobs themselves need Postgres, storage and a real CPU budget —
 * none of which a free edge runtime has — so this triggers them and nothing
 * more. Every decision about *what* the jobs do lives in `packages/core`, and
 * duplicating any of it here would create a second copy to drift.
 *
 * Failures are logged and never thrown. A cron Worker that throws is retried
 * by the platform, and a retried sweep is a second sweep running beside the
 * first; the jobs are idempotent, but the free instance's CPU is not free of
 * consequences. The next firing is the retry.
 */

interface Env {
  readonly ZFAF_BASE_URL: string;
  /** `wrangler secret put CRON_SECRET`. Never in this file, never in Git. */
  readonly CRON_SECRET: string;
}

/**
 * Which jobs each schedule runs.
 *
 * Keyed by the cron expression exactly as `wrangler.toml` spells it — Cloudflare
 * passes the matched expression back, so a schedule added there without an
 * entry here fires and does nothing. That failure is silent, which is why the
 * lookup below treats a miss as an error worth logging.
 */
const SCHEDULES: Readonly<Record<string, readonly string[]>> = {
  '0 * * * *': ['sweep-media', 'redrive-media'],
  '17 3 * * *': ['expire-invitations'],
  '*/5 * * * *': ['flush-analytics'],
};

async function runJob(job: string, env: Env): Promise<void> {
  const response = await fetch(`${env.ZFAF_BASE_URL}/api/internal/jobs/${job}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  });

  if (!response.ok) {
    // The body, because the status alone cannot distinguish "the token is
    // wrong" (404) from "the job threw" (500), and those need different people.
    console.error(`[cron] ${job} → ${response.status}: ${await response.text()}`);
    return;
  }
  console.log(`[cron] ${job} → ${response.status}`);
}

export default {
  async scheduled(event: { cron: string }, env: Env, ctx: ExecutionContext): Promise<void> {
    const jobs = SCHEDULES[event.cron];
    if (!jobs) {
      console.error(`[cron] no jobs mapped to "${event.cron}" — check wrangler.toml`);
      return;
    }

    // Sequential, not parallel: on the smallest instance these compete for one
    // tenth of a CPU, and a sweep racing a redrive there is slower than either
    // alone. `waitUntil` keeps the Worker alive for the whole chain.
    ctx.waitUntil(
      (async () => {
        for (const job of jobs) {
          try {
            await runJob(job, env);
          } catch (error) {
            console.error(`[cron] ${job} threw: ${error instanceof Error ? error.message : error}`);
          }
        }
      })(),
    );
  },
};
