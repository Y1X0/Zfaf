import type { DeviceClass } from '../domain/visitor-hash.js';
import type { PendingAnalyticsEvent } from '../domain/analytics-event.js';

/**
 * The ports analytics needs (D8.1, D8.3, D8.4).
 *
 * Three separate interfaces rather than one, because they have genuinely
 * different lifetimes and different failure meanings. Losing the salt store
 * means we cannot count at all; losing the buffer means we lose up to a
 * minute of views; losing the repository means the dashboard is stale. A
 * caller should be able to see which of those it is dealing with.
 */

/**
 * The rotating salt (ADR-0009).
 *
 * The contract is not "give me a random string" — it is **"give me the one
 * value that every request in this UTC day agrees on, and make sure it stops
 * existing after it"**. Both halves matter: without agreement the unique count
 * is meaningless, and without expiry the anonymisation is a promise rather
 * than a property.
 *
 * Implementations must never write the salt anywhere durable. That is the
 * whole point of the ADR, and it is asserted directly in the tests.
 */
export interface DailySaltStore {
  /** The salt for the day `now` falls in, creating it if this is the first call. */
  currentSalt(now: Date): Promise<string>;
}

/**
 * Where a view waits until it is written (D8.3).
 *
 * A wedding invitation gets its traffic in bursts — a WhatsApp group of two
 * hundred people opens the link within a few minutes of each other. Writing a
 * row per view puts that burst straight onto the primary database at exactly
 * the moment the page has to stay fast. So views land here and are drained on
 * a timer.
 */
export interface AnalyticsBuffer {
  /** Appends one event. Must never throw — a lost view is not worth an error page. */
  push(event: PendingAnalyticsEvent): Promise<void>;
  /** Removes and returns up to `max` events. Returns fewer when the buffer runs dry. */
  drain(max: number): Promise<readonly PendingAnalyticsEvent[]>;
  /** How many events are waiting. For the flush report and for tests. */
  size(): Promise<number>;
}

export interface AnalyticsRepository {
  /** Writes a drained batch. One statement, not one per event. */
  recordBatch(events: readonly PendingAnalyticsEvent[]): Promise<number>;

  /**
   * The numbers behind one invitation's panel.
   *
   * Computed in SQL rather than by loading rows, because "unique visitors" is
   * `COUNT(DISTINCT visitor_hash)` and doing that in JavaScript would mean
   * pulling every event of every day into memory to answer a four-number
   * question.
   */
  statsFor(invitationId: string): Promise<InvitationAnalytics>;
}

export interface InvitationAnalytics {
  readonly views: number;
  /**
   * Distinct visitor hashes.
   *
   * Distinct **within a day**, and therefore approximate across a longer
   * range: the salt rotates, so the same person on two days counts twice. That
   * is the cost of not tracking anyone, it is stated in ADR-0009, and the
   * dashboard says so rather than implying a precision that does not exist.
   */
  readonly uniqueVisitors: number;
  readonly devices: Readonly<Record<DeviceClass, number>>;
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
}
