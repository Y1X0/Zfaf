import { Redis, type RedisOptions } from 'ioredis';

/**
 * The shared Redis connection.
 *
 * One client per process, created lazily. Redis multiplexes commands over a
 * single connection, so a second client buys nothing and costs a file
 * descriptor and a reconnect storm during a deploy.
 *
 * `lazyConnect` matters more than it looks: without it, importing this module
 * opens a socket, which means a build step that merely *loads* the route graph
 * tries to reach Redis. With it, the connection is made on the first command —
 * which is also what lets the analytics path degrade to "views not counted"
 * rather than "page failed" when Redis is unavailable.
 */

const OPTIONS: RedisOptions = {
  lazyConnect: true,
  /**
   * The offline queue stays **on**, and that is not a relaxation.
   *
   * `lazyConnect` means the socket opens on the first command rather than on
   * import. With the offline queue disabled, that very first command — the one
   * that triggers the connection — is rejected outright with "Stream isn't
   * writeable", because it is issued microseconds before the handshake
   * completes. In practice: the first visitor to open any invitation after a
   * deploy is never counted, forever, on every process start.
   *
   * The queue is what makes `lazyConnect` work: commands issued while the
   * connection is opening wait for it. It is bounded by the two settings
   * below, so a Redis that is genuinely gone still fails commands in a couple
   * of seconds rather than accumulating a backlog — which is the property that
   * mattered, and it is kept.
   */
  enableOfflineQueue: true,
  // Two attempts, then let the command fail. Analytics is best-effort by
  // design (see `recordView`), and a long retry queue would hold request
  // handlers open waiting for a server that is not coming back.
  maxRetriesPerRequest: 2,
  connectTimeout: 2000,
  retryStrategy: (times) => Math.min(times * 200, 2000),
};

let client: Redis | null = null;

export function getRedis(url: string): Redis {
  if (client) return client;
  client = new Redis(url, OPTIONS);
  // Without a listener, ioredis emits an unhandled `error` event and takes the
  // process down when Redis goes away — which would turn a degraded counter
  // into an outage.
  client.on('error', (error: Error) => {
    console.error(`[redis] ${error.message}`);
  });
  return client;
}

/** Closes the shared connection. Used by tests and by graceful shutdown. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const closing = client;
  client = null;
  await closing.quit().catch(() => closing.disconnect());
}
