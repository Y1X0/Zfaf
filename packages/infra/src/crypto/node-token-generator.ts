import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { IdGenerator, TokenGenerator } from '@zfaf/core';

/**
 * Token generation backed by Node's CSPRNG.
 *
 * Only hashes are ever persisted (ADR-0006), so a read-only database leak
 * yields no usable session, verification link or reset link.
 */
export class NodeTokenGenerator implements TokenGenerator {
  generate(bytes: number): string {
    // base64url: URL- and cookie-safe without further encoding.
    return randomBytes(bytes).toString('base64url');
  }

  hash(token: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
  }

  /**
   * Constant-time comparison.
   *
   * A byte-by-byte comparison leaks how much of a token was correct, which is
   * enough to reconstruct it one byte at a time.
   */
  verify(token: string, storedHash: Uint8Array): boolean {
    const candidate = this.hash(token);
    if (candidate.length !== storedHash.length) return false;
    return timingSafeEqual(candidate, storedHash);
  }
}

/**
 * Identifier generation.
 *
 * UUIDv7 for primary keys: time-ordered, so B-tree inserts stay sequential,
 * while remaining unguessable — unlike a serial, which publishes a counter.
 */
export class NodeIdGenerator implements IdGenerator {
  uuid(): string {
    return uuidV7();
  }

  token(bytes: number): string {
    return randomBytes(bytes).toString('base64url');
  }
}

let lastTimestamp = 0;
let intraMillisecondCounter = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit millisecond timestamp, then a counter, then randomness.
 *
 * Implemented here because Node 22 exposes no v7 generator, and the ordering
 * property is the entire reason for choosing v7 over v4: time-ordered keys keep
 * B-tree inserts sequential instead of scattering writes across the index.
 *
 * The 12-bit counter in `rand_a` is RFC 9562's "monotonic random" method. Pure
 * randomness there would break ordering *within* a millisecond — and at the
 * insert rates where index locality actually matters, many rows share one
 * millisecond, so that is precisely the case that must hold.
 */
function uuidV7(): string {
  const timestamp = Date.now();

  if (timestamp === lastTimestamp) {
    intraMillisecondCounter += 1;
    // 12 bits. On overflow, wait for the next millisecond rather than emit an
    // identifier that sorts before its predecessor.
    if (intraMillisecondCounter > 0x0fff) {
      while (Date.now() === lastTimestamp) {
        /* spin briefly; a sub-millisecond wait */
      }
      return uuidV7();
    }
  } else {
    lastTimestamp = timestamp;
    intraMillisecondCounter = 0;
  }

  const bytes = new Uint8Array(16);

  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version nibble plus the top 12 bits of the counter.
  bytes[6] = 0x70 | ((intraMillisecondCounter >> 8) & 0x0f);
  bytes[7] = intraMillisecondCounter & 0xff;

  // 62 bits of randomness, so identifiers stay unguessable.
  const random = randomBytes(8);
  bytes.set(random, 8);
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant RFC 4122

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Fallback for contexts that only need an opaque identifier. */
export function randomIdentifier(): string {
  return randomUUID();
}
