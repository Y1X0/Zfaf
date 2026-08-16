/**
 * Integrity checksum for a published snapshot (ADR-0005).
 *
 * A snapshot is written once and read for years. `invitation_versions` is
 * protected by a trigger that rejects UPDATE and DELETE, but a trigger only
 * guards the path through the database engine — a restore from a doctored
 * backup, a migration that rewrites JSONB, or a bug in a future publish path
 * all leave the row looking untouched. The checksum is what makes such a change
 * *detectable* rather than merely *disallowed*.
 *
 * Two properties are required and neither is optional:
 *
 *   • **Canonical.** The same document must hash identically no matter what
 *     order its keys arrive in — JSON object order is not semantic, and
 *     round-tripping through PostgreSQL JSONB reorders keys freely.
 *   • **Complete.** Every value in the document must reach the digest. A
 *     checksum that ignores nested content is worse than none: it reports
 *     "verified" about bytes it never read.
 *
 * Implemented here rather than with `node:crypto` because `@zfaf/core` is
 * bundled into the browser by the builder, and a Node built-in in this package
 * breaks that bundle. The implementation is the published FIPS 180-4 algorithm
 * and is checked against the NIST vectors in the tests.
 */

/**
 * RFC 8785-style canonical serialisation, restricted to what a snapshot holds.
 *
 * Object keys are emitted in code-unit order; arrays keep their order, because
 * in a snapshot the order of sections and photographs *is* the content.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      // NaN and Infinity have no JSON form; a snapshot containing one is
      // corrupt, and silently writing `null` would hide that.
      if (!Number.isFinite(value)) {
        throw new TypeError('A snapshot cannot contain a non-finite number');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      // `undefined` is not JSON. It cannot survive the round trip through the
      // database, so hashing it would produce a checksum that never verifies.
      throw new TypeError('A snapshot cannot contain undefined');
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are absent from JSON rather than being an error:
    // `{a: undefined}` and `{}` are the same document once stored.
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalize(member)}`).join(',')}}`;
}

// ── SHA-256 (FIPS 180-4) ────────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  const message = utf8Bytes(input);
  const bitLength = message.length * 8;

  // Padded to a multiple of 64 bytes: 0x80, zeroes, then the 64-bit length.
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  // A snapshot never approaches 2^32 bits, so the high word is always zero.
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLength >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const view = new DataView(padded.buffer);

  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(block + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [
      h[0] as number,
      h[1] as number,
      h[2] as number,
      h[3] as number,
      h[4] as number,
      h[5] as number,
      h[6] as number,
      h[7] as number,
    ];

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + (K[index] as number) + (w[index] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  let hex = '';
  for (const word of h) hex += word.toString(16).padStart(8, '0');
  return hex;
}

/** UTF-8 encoding without assuming `TextEncoder` exists on every runtime. */
function utf8Bytes(input: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input);

  const bytes: number[] = [];
  for (const character of input) {
    let code = character.codePointAt(0) as number;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
    code = 0;
  }
  return Uint8Array.from(bytes);
}

// ── the public surface ──────────────────────────────────────────────────────

/**
 * The algorithm tag is part of the stored value.
 *
 * Without it, changing the digest later would make every historical checksum
 * silently fail to verify with no way to tell "tampered" from "hashed by an
 * older release".
 */
const CHECKSUM_PREFIX = 'sha256-';

export function snapshotChecksum(snapshot: unknown): string {
  return `${CHECKSUM_PREFIX}${sha256Hex(canonicalize(snapshot))}`;
}

export type ChecksumVerdict = 'MATCH' | 'MISMATCH' | 'UNKNOWN_ALGORITHM';

/**
 * Verifies a stored checksum.
 *
 * A digest we do not recognise is reported as its own outcome rather than as a
 * mismatch: an old row hashed by a superseded algorithm is not evidence of
 * tampering, and treating it as such would take honest invitations offline.
 */
export function verifySnapshotChecksum(snapshot: unknown, stored: string): ChecksumVerdict {
  if (!stored.startsWith(CHECKSUM_PREFIX)) return 'UNKNOWN_ALGORITHM';
  return snapshotChecksum(snapshot) === stored ? 'MATCH' : 'MISMATCH';
}
