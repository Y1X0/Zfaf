import type { Redis } from 'ioredis';

import {
  type AnalyticsBuffer,
  type PendingAnalyticsEvent,
  decodeBufferedEvent,
  encodeBufferedEvent,
} from '@zfaf/core';

/**
 * Where views wait for the flush (D8.3).
 *
 * A Redis list used as a queue: `LPUSH` on the way in, `RPOP` with a count on
 * the way out, so the oldest events are written first and two flushers racing
 * cannot hand the same event to the database twice — `RPOP key n` is atomic,
 * unlike a `LRANGE` followed by an `LTRIM`.
 *
 * The list is capped. An unbounded buffer during a database outage would grow
 * until Redis started evicting keys of its own choosing — possibly the daily
 * salt. A bounded one drops the newest views instead, which is a number being
 * slightly low on a chart rather than a privacy mechanism disappearing. When
 * it does drop, it says so; a silent cap reads as "we counted everything".
 */

const KEY = 'zfaf:analytics:pending';

/** Roughly 15 MB at ~150 bytes an event, and about a day of traffic for a busy invitation. */
export const BUFFER_MAX_EVENTS = 100_000;

export class RedisAnalyticsBuffer implements AnalyticsBuffer {
  private overflowReported = false;

  constructor(
    private readonly redis: Redis,
    private readonly key: string = KEY,
  ) {}

  async push(event: PendingAnalyticsEvent): Promise<void> {
    /**
     * Push and trim in one round trip.
     *
     * `LTRIM 0 max-1` keeps the newest `max` entries. It runs on every push
     * rather than periodically because a periodic check is a thing that can be
     * missed exactly when it matters — during the burst that caused the
     * overflow.
     */
    const results = await this.redis
      .multi()
      .lpush(this.key, encodeBufferedEvent(event))
      .ltrim(this.key, 0, BUFFER_MAX_EVENTS - 1)
      .exec();

    const pushed = results?.[0]?.[1];
    if (typeof pushed === 'number' && pushed > BUFFER_MAX_EVENTS && !this.overflowReported) {
      this.overflowReported = true;
      console.warn(
        `[analytics] buffer is at its ${BUFFER_MAX_EVENTS} event cap; oldest views are being dropped. ` +
          'The flush is not keeping up — check the database and the worker.',
      );
    }
  }

  async drain(max: number): Promise<readonly PendingAnalyticsEvent[]> {
    const raw = await this.redis.rpop(this.key, Math.max(1, Math.trunc(max)));
    if (!raw || raw.length === 0) return [];

    const events: PendingAnalyticsEvent[] = [];
    let undecodable = 0;

    for (const entry of raw) {
      const decoded = decodeBufferedEvent(entry);
      if (decoded) events.push(decoded);
      else undecodable += 1;
    }

    if (undecodable > 0) {
      // Dropped rather than retried: an entry this side of the boundary that
      // does not parse will not parse next time either, and a poison pill in a
      // view counter is not worth a stuck queue.
      console.warn(`[analytics] discarded ${undecodable} unreadable buffered event(s)`);
    }

    return events;
  }

  async size(): Promise<number> {
    return await this.redis.llen(this.key);
  }
}
