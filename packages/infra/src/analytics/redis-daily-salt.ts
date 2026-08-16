import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import { type DailySaltStore, saltDay } from '@zfaf/core';

/**
 * The rotating salt, in Redis and nowhere else (D8.1, ADR-0009).
 *
 * The privacy claim this platform makes is: *after the day is over, nobody —
 * including us — can reverse a visitor hash or link a visitor across two days*.
 * That claim is only true if the salt genuinely stops existing, so:
 *
 *   • it is written to Redis with a TTL and to **no other store** — not
 *     PostgreSQL, not a file, not an environment variable;
 *   • Redis is deployed with persistence off for this reason, so the salt is
 *     never in an RDB snapshot or an AOF log waiting to be restored;
 *   • it is minted with `SET NX`, so the first request of the day wins and
 *     every later one reads the same value. Two processes racing produce one
 *     salt, not two, which is what makes "unique visitors" a real number.
 *
 * The TTL is a little over a day. Exactly 24 hours would let a request that
 * arrives a few milliseconds either side of midnight find no salt for its own
 * day and mint a second one; the extra hours cost nothing and remove the edge.
 */

/** 32 bytes of CSPRNG output. Not derived from anything, so it cannot be recomputed. */
const SALT_BYTES = 32;

const SALT_TTL_SECONDS = 26 * 60 * 60;

const KEY_PREFIX = 'zfaf:analytics:salt:';

export class RedisDailySalt implements DailySaltStore {
  constructor(private readonly redis: Redis) {}

  async currentSalt(now: Date): Promise<string> {
    const key = `${KEY_PREFIX}${saltDay(now)}`;

    /**
     * `NX` then `GET`, in that order.
     *
     * `SET key value NX EX ttl` succeeds only if nobody has minted today's
     * salt yet. Either way the following `GET` returns whatever is actually
     * stored, so a process that lost the race uses the winner's value rather
     * than its own. Reversing the two would reintroduce the race this avoids.
     */
    const candidate = randomBytes(SALT_BYTES).toString('base64url');
    await this.redis.set(key, candidate, 'EX', SALT_TTL_SECONDS, 'NX');

    const stored = await this.redis.get(key);
    if (stored) return stored;

    /**
     * The key vanished between the write and the read.
     *
     * Possible if Redis evicted it under memory pressure. Returning the
     * candidate keeps the request working; the consequence is that a handful
     * of hashes that minute do not match the rest of the day's, which
     * marginally overstates unique visitors. Failing the request instead would
     * cost a view for no privacy gain.
     */
    return candidate;
  }

  /** The TTL Redis reports for a day's salt, or null if the key is gone. Tests use this. */
  async ttlFor(now: Date): Promise<number | null> {
    const ttl = await this.redis.ttl(`${KEY_PREFIX}${saltDay(now)}`);
    return ttl < 0 ? null : ttl;
  }
}
