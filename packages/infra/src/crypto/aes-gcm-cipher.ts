import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { SecretCipher } from '@zfaf/core';

/**
 * AES-256-GCM for the one credential that cannot be hashed (docs/09 §2.8).
 *
 * A TOTP secret has to be recoverable — verification recomputes an HMAC from
 * the original bytes — so "store a hash" is not available here as it is for
 * every other credential in the system. Encryption is the alternative, and it
 * is only worth anything if the key lives somewhere the ciphertext does not:
 * `TOTP_ENCRYPTION_KEY` comes from the secret manager, never from the database.
 *
 * **GCM, not CBC.** The ciphertext must be *authenticated*, not merely
 * confidential: a row an attacker can flip bits in is a secret an attacker can
 * steer, and an unauthenticated mode would decrypt the result without
 * complaint. `decrypt` returns null on a failed tag rather than throwing,
 * because a wrong key at startup should surface as a refused login, not as an
 * unhandled exception in a request handler.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12; // 96 bits, the GCM-recommended size
const TAG_BYTES = 16;

/**
 * Derives the AES key from the configured secret.
 *
 * HKDF rather than using the string's bytes directly: the configured value is
 * a passphrase-shaped thing of arbitrary length and unknown distribution, and
 * AES-256 wants 32 uniformly-random bytes. The `info` string domain-separates
 * this key from any other use of the same secret, so a future feature that
 * derives from the same material cannot decrypt these rows.
 */
export function deriveEncryptionKey(secret: string): Uint8Array {
  return new Uint8Array(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'zfaf:totp:v1', KEY_BYTES),
  );
}

export class AesGcmSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) {
      // Refusing at construction rather than at first use: a key too short to
      // be worth having should stop the process, not one login.
      throw new Error('TOTP_ENCRYPTION_KEY must be at least 32 characters');
    }
    this.key = Buffer.from(deriveEncryptionKey(secret));
  }

  /** Returns nonce ‖ ciphertext ‖ tag, so nothing else has to store a nonce. */
  encrypt(plaintext: Uint8Array): Uint8Array {
    // A fresh random nonce per encryption. Reusing one under GCM is
    // catastrophic — it leaks the XOR of two plaintexts and the auth key.
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    return new Uint8Array(Buffer.concat([nonce, body, cipher.getAuthTag()]));
  }

  decrypt(sealed: Uint8Array): Uint8Array | null {
    if (sealed.length < NONCE_BYTES + TAG_BYTES) return null;

    const buffer = Buffer.from(sealed);
    const nonce = buffer.subarray(0, NONCE_BYTES);
    const tag = buffer.subarray(buffer.length - TAG_BYTES);
    const body = buffer.subarray(NONCE_BYTES, buffer.length - TAG_BYTES);

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      // A failed tag. Wrong key, tampered row, or truncated column — all three
      // mean "this is not our plaintext", and none of them has a safe guess.
      return null;
    }
  }
}
