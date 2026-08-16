import { describe, expect, it } from 'vitest';

import {
  RECOVERY_CODE_ALPHABET,
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  formatRecoveryCode,
  hmacSha1,
  hotpCode,
  isWellFormedRecoveryCode,
  otpauthUri,
  recoveryCodeFromBytes,
  sha1,
  timingSafeStringEqual,
  totpCodeAt,
  totpStepAt,
  verifyTotp,
} from './totp.js';

/**
 * The published vectors, not vectors of our own devising.
 *
 * An implementation checked only against itself proves that it is consistent,
 * which is exactly what a wrong implementation also is. Every value below comes
 * from FIPS 180-4, RFC 2202, RFC 4226 Appendix D or RFC 6238 Appendix B, so a
 * passing suite says the codes we generate are the codes a phone will show.
 */

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('SHA-1 against FIPS 180-4', () => {
  it.each([
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    ],
  ])('hashes %j', (input, expected) => {
    expect(hex(sha1(encoder.encode(input)))).toBe(expected);
  });

  it('hashes a million characters (the FIPS long message)', () => {
    expect(hex(sha1(encoder.encode('a'.repeat(1_000_000))))).toBe(
      '34aa973cd4c4daa4f61eeb2bdbad27316534016f',
    );
  });
});

describe('HMAC-SHA1 against RFC 2202', () => {
  it('handles a key shorter than the block size', () => {
    expect(hex(hmacSha1(new Uint8Array(20).fill(0x0b), encoder.encode('Hi There')))).toBe(
      'b617318655057264e28bc0b6fb378c8ef146be00',
    );
  });

  it('handles an ASCII key', () => {
    expect(
      hex(hmacSha1(encoder.encode('Jefe'), encoder.encode('what do ya want for nothing?'))),
    ).toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  });

  it('hashes a key longer than the block size first', () => {
    expect(
      hex(
        hmacSha1(
          new Uint8Array(80).fill(0xaa),
          encoder.encode('Test Using Larger Than Block-Size Key - Hash Key First'),
        ),
      ),
    ).toBe('aa4ae5e15272d00e95705637ce8a3b55ed402112');
  });
});

describe('HOTP against RFC 4226 Appendix D', () => {
  // The RFC's shared secret, verbatim.
  const secret = encoder.encode('12345678901234567890');
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it.each(expected.map((code, counter) => [counter, code]))(
    'counter %i produces %s',
    (counter, code) => {
      expect(hotpCode(secret, counter as number)).toBe(code);
    },
  );
});

describe('TOTP against RFC 6238 Appendix B', () => {
  const secret = encoder.encode('12345678901234567890');

  // Appendix B's SHA-1 rows, truncated to the six digits we emit.
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at unix time %i the code is %s', (seconds, code) => {
    expect(totpCodeAt(secret, new Date((seconds as number) * 1000))).toBe(code);
  });
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, index) => index * 7);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('matches RFC 4648 for the canonical strings', () => {
    expect(base32Encode(encoder.encode('foobar'))).toBe('MZXW6YTBOI');
  });

  it('accepts what a person actually types', () => {
    const bytes = encoder.encode('foobar');
    expect(base32Decode('mzxw 6ytb oi')).toEqual(bytes);
    expect(base32Decode('MZXW6YTBOI======')).toEqual(bytes);
  });

  it('rejects a string that is not base32 rather than guessing', () => {
    expect(base32Decode('MZXW6YTB01')).toBeNull(); // zero and one are not in the alphabet
    expect(base32Decode('')).toBeNull();
  });
});

describe('verifying a submitted code', () => {
  const secret = encoder.encode('12345678901234567890');
  const at = (seconds: number) => new Date(seconds * 1000);

  it('accepts the current code and reports the step it consumed', () => {
    const now = at(1111111111);
    const verdict = verifyTotp({ secret, code: totpCodeAt(secret, now), now, lastUsedStep: null });
    expect(verdict).toEqual({ ok: true, step: totpStepAt(now) });
  });

  it('accepts a code one step old, for a phone whose clock has drifted', () => {
    const now = at(1111111111);
    const previous = totpCodeAt(secret, at(1111111111 - TOTP_PERIOD_SECONDS));
    expect(verifyTotp({ secret, code: previous, now, lastUsedStep: null }).ok).toBe(true);
  });

  it('refuses a code two steps old', () => {
    const now = at(1111111111);
    const stale = totpCodeAt(secret, at(1111111111 - TOTP_PERIOD_SECONDS * 2));
    expect(verifyTotp({ secret, code: stale, now, lastUsedStep: null })).toEqual({
      ok: false,
      reason: 'INVALID',
    });
  });

  it('refuses a code that has already been used, even while it is still valid', () => {
    // The whole point of replay protection: the code is *correct* here.
    const now = at(1111111111);
    const step = totpStepAt(now);
    expect(verifyTotp({ secret, code: totpCodeAt(secret, now), now, lastUsedStep: step })).toEqual({
      ok: false,
      reason: 'REPLAYED',
    });
  });

  it('refuses an earlier code once a later one has been used', () => {
    const now = at(1111111111);
    const previous = totpCodeAt(secret, at(1111111111 - TOTP_PERIOD_SECONDS));
    expect(verifyTotp({ secret, code: previous, now, lastUsedStep: totpStepAt(now) })).toEqual({
      ok: false,
      reason: 'REPLAYED',
    });
  });

  it('separates malformed input from a wrong code', () => {
    const now = at(1111111111);
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 5']) {
      expect(verifyTotp({ secret, code, now, lastUsedStep: null }).ok).toBe(false);
      expect(
        (verifyTotp({ secret, code, now, lastUsedStep: null }) as { reason: string }).reason,
      ).toBe('MALFORMED');
    }
  });

  it('tolerates the spaces an authenticator shows the code with', () => {
    const now = at(1111111111);
    const spaced = totpCodeAt(secret, now).replace(/^(\d{3})(\d{3})$/, '$1 $2');
    expect(verifyTotp({ secret, code: spaced, now, lastUsedStep: null }).ok).toBe(true);
  });
});

describe('timingSafeStringEqual', () => {
  it('agrees with ===  on every case that matters', () => {
    expect(timingSafeStringEqual('123456', '123456')).toBe(true);
    expect(timingSafeStringEqual('123456', '123457')).toBe(false);
    expect(timingSafeStringEqual('123456', '023456')).toBe(false);
    expect(timingSafeStringEqual('123456', '12345')).toBe(false);
  });
});

describe('the otpauth URI', () => {
  it('carries the parameters an authenticator needs, and encodes the label', () => {
    const uri = otpauthUri({
      secret: encoder.encode('12345678901234567890'),
      account: 'ops@zfaf.app',
      issuer: 'Zfaf Admin',
    });

    expect(uri.startsWith('otpauth://totp/Zfaf%20Admin%3Aops%40zfaf.app?')).toBe(true);
    const query = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
    expect(query.get('secret')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(query.get('algorithm')).toBe('SHA1');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
    expect(query.get('issuer')).toBe('Zfaf Admin');
  });
});

describe('recovery codes', () => {
  it('formats as two readable groups', () => {
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });

  it('accepts the code however it is typed back', () => {
    expect(isWellFormedRecoveryCode('abcde-fghjk')).toBe(true);
    expect(isWellFormedRecoveryCode('ABCDE FGHJK')).toBe(true);
    expect(isWellFormedRecoveryCode('ABCDEFGHJK')).toBe(true);
  });

  it('rejects the characters that are misread off a printout', () => {
    // 0/O and 1/I/L are absent from the alphabet on purpose.
    expect(RECOVERY_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(isWellFormedRecoveryCode('ABCDE-FGH0K')).toBe(false);
    expect(isWellFormedRecoveryCode('ABCDE-FGHJ')).toBe(false);
  });

  it('derives a well-formed code from bytes, deterministically', () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index * 13);
    expect(recoveryCodeFromBytes(bytes)).toBe(recoveryCodeFromBytes(bytes));
    expect(isWellFormedRecoveryCode(recoveryCodeFromBytes(bytes))).toBe(true);
  });
});
