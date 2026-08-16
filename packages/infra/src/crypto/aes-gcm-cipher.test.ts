import { describe, expect, it } from 'vitest';

import { AesGcmSecretCipher, deriveEncryptionKey } from './aes-gcm-cipher.js';

/**
 * The cipher that protects TOTP secrets at rest (docs/09 §2.8).
 *
 * What matters here is not that it round-trips — almost anything does — but
 * that it *fails* correctly: a tampered row, a truncated column and the wrong
 * key must all produce null rather than plausible bytes, because plausible
 * bytes would become a second factor an attacker chose.
 */

const KEY = 'a-test-encryption-key-of-at-least-32-characters';
const OTHER_KEY = 'a-different-test-key-of-at-least-32-characters!!';

const secret = Uint8Array.from({ length: 20 }, (_, index) => index * 11);

describe('AesGcmSecretCipher', () => {
  it('round-trips a TOTP secret', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    expect(cipher.decrypt(cipher.encrypt(secret))).toEqual(secret);
  });

  it('produces different ciphertext each time, from a fresh nonce', () => {
    // Nonce reuse under GCM leaks the XOR of two plaintexts and the auth key.
    // Identical output for identical input would be the visible symptom.
    const cipher = new AesGcmSecretCipher(KEY);
    const first = cipher.encrypt(secret);
    const second = cipher.encrypt(secret);
    expect([...first]).not.toEqual([...second]);
    expect(cipher.decrypt(first)).toEqual(cipher.decrypt(second));
  });

  it('does not leave the plaintext visible in the ciphertext', () => {
    const sealed = new AesGcmSecretCipher(KEY).encrypt(secret);
    const haystack = Buffer.from(sealed).toString('hex');
    expect(haystack).not.toContain(Buffer.from(secret).toString('hex'));
  });

  it('refuses a ciphertext whose bytes were changed', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const sealed = cipher.encrypt(secret);

    // Every byte position, one at a time: nonce, body and tag alike.
    for (let index = 0; index < sealed.length; index += 1) {
      const tampered = Uint8Array.from(sealed);
      tampered[index] = ((tampered[index] as number) ^ 0x01) & 0xff;
      expect(cipher.decrypt(tampered), `byte ${index} went undetected`).toBeNull();
    }
  });

  it('refuses a ciphertext sealed with a different key', () => {
    const sealed = new AesGcmSecretCipher(KEY).encrypt(secret);
    expect(new AesGcmSecretCipher(OTHER_KEY).decrypt(sealed)).toBeNull();
  });

  it('refuses input too short to contain a nonce and a tag', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    expect(cipher.decrypt(new Uint8Array(0))).toBeNull();
    expect(cipher.decrypt(new Uint8Array(27))).toBeNull();
  });

  it('refuses to be constructed with a key too short to be worth having', () => {
    // At construction, not at first use: this should stop the process, not one
    // login at three in the morning.
    expect(() => new AesGcmSecretCipher('short')).toThrow(/at least 32/);
  });

  it('derives a 32-byte key, and a different one per secret', () => {
    expect(deriveEncryptionKey(KEY)).toHaveLength(32);
    expect([...deriveEncryptionKey(KEY)]).not.toEqual([...deriveEncryptionKey(OTHER_KEY)]);
  });

  it('derives deterministically, so a restart can still read what it wrote', () => {
    expect([...deriveEncryptionKey(KEY)]).toEqual([...deriveEncryptionKey(KEY)]);
  });

  it('domain-separates its key from the raw secret', () => {
    // A future feature deriving from the same configured value must not be
    // able to read these rows.
    expect(Buffer.from(deriveEncryptionKey(KEY)).toString('utf8')).not.toContain(KEY.slice(0, 8));
  });
});
