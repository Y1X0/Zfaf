/**
 * Time-based one-time passwords (RFC 4226, RFC 6238) — docs/09 §2.8.
 *
 * Implemented here rather than pulled from a package, for the same reason
 * `snapshot-checksum.ts` implements SHA-256 by hand: `@zfaf/core` is bundled
 * into the browser by the builder, so a `node:crypto` import in this package
 * breaks that bundle. The algorithms below are published, fixed, and checked
 * against the official vectors in `totp.test.ts` — RFC 4226 Appendix D and
 * RFC 6238 Appendix B — which is stronger verification than most dependencies
 * carry.
 *
 * **SHA-1, deliberately.** RFC 6238 permits SHA-256 and SHA-512, and every
 * authenticator people actually have — Google Authenticator, Authy, 1Password,
 * iOS Passwords — implements SHA-1 and silently produces wrong codes for the
 * others. A stronger hash that locks an operator out of the admin console at
 * 3am is not the stronger choice. The security of TOTP rests on the secret and
 * the 30-second window, not on the hash's collision resistance.
 */

// ── SHA-1 (FIPS 180-4) ──────────────────────────────────────────────────────

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** SHA-1 of a byte string. Returns 20 bytes. */
export function sha1(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  // Message + 0x80 + zero padding to 56 mod 64 + 8-byte big-endian length.
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  // Lengths beyond 2^32 bits cannot occur here; the high word stays zero.
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(
        (w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number),
        1,
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + (w[i] as number)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  new DataView(digest.buffer).setUint32(0, h0, false);
  new DataView(digest.buffer).setUint32(4, h1, false);
  new DataView(digest.buffer).setUint32(8, h2, false);
  new DataView(digest.buffer).setUint32(12, h3, false);
  new DataView(digest.buffer).setUint32(16, h4, false);
  return digest;
}

/** HMAC-SHA1 (RFC 2104), block size 64 bytes. */
export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const BLOCK = 64;
  let normalisedKey = key;
  if (normalisedKey.length > BLOCK) normalisedKey = sha1(normalisedKey);

  const padded = new Uint8Array(BLOCK);
  padded.set(normalisedKey);

  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 20);
  for (let i = 0; i < BLOCK; i += 1) {
    inner[i] = (padded[i] as number) ^ 0x36;
    outer[i] = (padded[i] as number) ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(sha1(inner), BLOCK);
  return sha1(outer);
}

// ── base32, because that is what authenticator apps read ────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Decodes base32, tolerating the two things people do when typing a secret:
 * lower case, and the spaces authenticator apps display it with. Padding is
 * accepted and ignored. Anything else is a malformed secret, not a guess.
 */
export function base32Decode(input: string): Uint8Array | null {
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (cleaned.length === 0) return null;

  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

// ── TOTP ────────────────────────────────────────────────────────────────────

/** RFC 6238 default. Every authenticator assumes it; none let a user change it. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How far either side of now a code is accepted.
 *
 * One step — ±30 seconds — covers a phone whose clock has drifted and a person
 * who starts typing as the code is about to roll. Wider windows are a common
 * default and they multiply the number of codes valid at any instant, which is
 * the one number a brute-force attacker cares about.
 */
export const TOTP_WINDOW_STEPS = 1;

/** 20 bytes: the RFC 4226 recommendation, and what every authenticator expects. */
export const TOTP_SECRET_BYTES = 20;

export function totpStepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one counter value (RFC 4226 §5.3, dynamic truncation). */
export function hotpCode(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);

  const digest = hmacSha1(secret, message);
  const offset = (digest[19] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpCodeAt(secret: Uint8Array, now: Date, digits = TOTP_DIGITS): string {
  return hotpCode(secret, totpStepAt(now), digits);
}

/**
 * Compares two strings in time independent of where they first differ.
 *
 * A code is six digits. Without this, the response time leaks how many leading
 * digits were right, and six digits fall in far fewer than a million attempts.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export type TotpVerdict =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'INVALID' | 'REPLAYED' };

export interface TotpVerifyInput {
  readonly secret: Uint8Array;
  readonly code: string;
  readonly now: Date;
  /**
   * The highest step this credential has already been used with.
   *
   * Replay protection, and it is not optional: without it a code shoulder-surfed
   * or read from a phishing page stays usable for the rest of its 30-second
   * window — and a window is long enough for a person to retype it elsewhere.
   */
  readonly lastUsedStep: number | null;
}

/**
 * Verifies one submitted code.
 *
 * Every accepted step is returned so the caller can persist it; a caller that
 * forgets to would silently lose replay protection, which is why `lastUsedStep`
 * is a required input rather than an option with a default.
 */
export function verifyTotp(input: TotpVerifyInput): TotpVerdict {
  const normalised = input.code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(normalised)) return { ok: false, reason: 'MALFORMED' };

  const current = totpStepAt(input.now);
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
    const step = current + delta;
    if (!timingSafeStringEqual(hotpCode(input.secret, step), normalised)) continue;
    // The code is right. Whether it is *usable* is a separate question.
    if (input.lastUsedStep !== null && step <= input.lastUsedStep) {
      return { ok: false, reason: 'REPLAYED' };
    }
    return { ok: true, step };
  }

  return { ok: false, reason: 'INVALID' };
}

/**
 * The `otpauth://` URI an authenticator scans.
 *
 * The label and issuer are percent-encoded because an account name is an email
 * address and an issuer may contain a space — an unencoded `:` in the label
 * silently changes which issuer the app files the entry under.
 */
export function otpauthUri(options: {
  readonly secret: Uint8Array;
  readonly account: string;
  readonly issuer: string;
}): string {
  const label = encodeURIComponent(`${options.issuer}:${options.account}`);
  const parameters = new URLSearchParams({
    secret: base32Encode(options.secret),
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

// ── recovery codes ──────────────────────────────────────────────────────────

/** Ten, shown once, per docs/09 §2.8. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * `xxxxx-xxxxx` from an unambiguous alphabet.
 *
 * No `0`/`O`, no `1`/`I`/`L`: these are read off a printout or a screenshot by
 * somebody who has already lost their phone and is not having a good day.
 */
export const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const RECOVERY_CODE_GROUP = 5;

export function formatRecoveryCode(raw: string): string {
  const cleaned = normaliseRecoveryCode(raw);
  return `${cleaned.slice(0, RECOVERY_CODE_GROUP)}-${cleaned.slice(RECOVERY_CODE_GROUP)}`;
}

/** Upper case, dashes and spaces removed — how the code is compared and hashed. */
export function normaliseRecoveryCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export function isWellFormedRecoveryCode(raw: string): boolean {
  const cleaned = normaliseRecoveryCode(raw);
  if (cleaned.length !== RECOVERY_CODE_GROUP * 2) return false;
  return [...cleaned].every((character) => RECOVERY_CODE_ALPHABET.includes(character));
}

/**
 * Turns random bytes into a recovery code.
 *
 * The randomness comes from a port, so this stays pure and the test suite can
 * assert on a known byte string instead of on "some code appeared".
 */
export function recoveryCodeFromBytes(bytes: Uint8Array): string {
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_GROUP * 2; i += 1) {
    const byte = bytes[i % bytes.length] as number;
    code += RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length];
  }
  return formatRecoveryCode(code);
}
