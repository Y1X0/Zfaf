import type { RateLimiter, RateLimitVerdict } from '@zfaf/core';

/**
 * Sliding-window rate limiter.
 *
 * A sliding window rather than a fixed one because fixed windows have a well
 * known flaw: an attacker who sends the full quota at 14:59:59 and again at
 * 15:00:01 gets double the intended rate at the boundary. For a login endpoint
 * that doubling is exactly what matters.
 *
 * This in-memory implementation is correct and fully tested, and is what runs
 * in development and in tests. A Redis-backed implementation of the same port
 * lands with the HTTP layer, where limits are actually applied across
 * instances; nothing above the port changes.
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxTrackedKeys = 100_000) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
    now: Date,
  ): Promise<RateLimitVerdict> {
    const timestamps = this.prune(key, windowMs, now);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0] as number;
      const resetAt = new Date(oldest + windowMs);
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
      };
    }

    timestamps.push(now.getTime());
    this.hits.set(key, timestamps);
    this.evictIfNeeded();

    return {
      allowed: true,
      remaining: limit - timestamps.length,
      resetAt: new Date(now.getTime() + windowMs),
    };
  }

  /** Reports the verdict without recording an attempt. */
  async peek(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitVerdict> {
    const timestamps = this.prune(key, windowMs, now);
    const allowed = timestamps.length < limit;
    const oldest = timestamps[0];
    return {
      allowed,
      remaining: Math.max(0, limit - timestamps.length),
      resetAt: new Date((oldest ?? now.getTime()) + windowMs),
    };
  }

  /** Clears a key — a successful sign-in forgives earlier failures. */
  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }

  private prune(key: string, windowMs: number, now: Date): number[] {
    const cutoff = now.getTime() - windowMs;
    const existing = this.hits.get(key) ?? [];
    const kept = existing.filter((timestamp) => timestamp > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  /**
   * Bounds memory.
   *
   * Without this, an attacker rotating keys turns the limiter itself into a
   * denial-of-service vector against us.
   */
  private evictIfNeeded(): void {
    if (this.hits.size <= this.maxTrackedKeys) return;
    const excess = this.hits.size - this.maxTrackedKeys;
    let removed = 0;
    for (const key of this.hits.keys()) {
      this.hits.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

/**
 * A limiter that permits everything.
 *
 * For tests that are not about rate limiting. Deliberately named so that using
 * it anywhere near production code is obvious in review.
 */
export class NoopRateLimiter implements RateLimiter {
  async consume(
    _key: string,
    limit: number,
    windowMs: number,
    now: Date,
  ): Promise<RateLimitVerdict> {
    return { allowed: true, remaining: limit, resetAt: new Date(now.getTime() + windowMs) };
  }
  async peek(_key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitVerdict> {
    return { allowed: true, remaining: limit, resetAt: new Date(now.getTime() + windowMs) };
  }
  async reset(): Promise<void> {}
}
