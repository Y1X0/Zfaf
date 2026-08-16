/**
 * Background worker process.
 *
 * Runs separately from the web app from day one so image processing and mail
 * delivery never share a request budget with page rendering, and so it can be
 * scaled independently (docs/08-backend-architecture.md §6).
 *
 * Job handlers (media processing, OG generation, mail, retention) land with
 * their owning milestones. M0 only establishes the process and its lifecycle.
 */

const shutdownSignals = ['SIGINT', 'SIGTERM'] as const;

function start(): void {
  console.warn('[worker] started; no queues registered yet (M0)');

  for (const signal of shutdownSignals) {
    process.on(signal, () => {
      console.warn(`[worker] received ${signal}, shutting down`);
      process.exit(0);
    });
  }
}

start();
