import { describe, expect, it } from 'vitest';

import { ARGON2ID_PARAMETERS } from '@zfaf/core';
import { Argon2PasswordHasher } from './argon2-password-hasher.js';
import { NodeIdGenerator, NodeTokenGenerator } from './node-token-generator.js';

/**
 * The real cryptographic adapters.
 *
 * The use-case suite runs against a fast stand-in so it stays quick; these
 * tests exercise the implementations that actually ship.
 */

describe('argon2id password hashing', () => {
  const hasher = new Argon2PasswordHasher();

  it('produces an argon2id PHC string with the OWASP parameters', async () => {
    const hash = await hasher.hash('correct-horse-battery-staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain(`m=${ARGON2ID_PARAMETERS.memoryCost}`);
    expect(hash).toContain(`t=${ARGON2ID_PARAMETERS.timeCost}`);
    expect(hash).toContain(`p=${ARGON2ID_PARAMETERS.parallelism}`);
  });

  it('never contains the plaintext', async () => {
    const password = 'a-very-distinctive-passphrase';
    expect(await hasher.hash(password)).not.toContain(password);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([hasher.hash('same'), hasher.hash('same')]);
    expect(first).not.toBe(second);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct-horse-battery-staple');
    expect(await hasher.verify(hash, 'correct-horse-battery-staple')).toBe(true);
    expect(await hasher.verify(hash, 'correct-horse-battery-stapl')).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('fails closed on a malformed stored hash rather than throwing', async () => {
    // A stored value that cannot be parsed must not be distinguishable by the
    // caller from a wrong password.
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
    expect(await hasher.verify('', 'anything')).toBe(false);
  });

  it('handles Arabic and emoji passphrases', async () => {
    const passphrase = 'كلمة-سر-طويلة-جداً-٢٠٢٦';
    const hash = await hasher.hash(passphrase);
    expect(await hasher.verify(hash, passphrase)).toBe(true);
  });

  it('does not ask to rehash a current hash', async () => {
    expect(hasher.needsRehash(await hasher.hash('x-long-enough-passphrase'))).toBe(false);
  });

  it('asks to rehash weaker parameters, so an increase reaches existing users', () => {
    expect(hasher.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('asks to rehash a hash from another algorithm entirely', () => {
    expect(hasher.needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
    expect(hasher.needsRehash('plaintext-somehow')).toBe(true);
  });
}, 30_000);

describe('token generation', () => {
  const tokens = new NodeTokenGenerator();

  it('produces URL-safe tokens', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(tokens.generate(32)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces unique tokens', () => {
    const generated = new Set(Array.from({ length: 1000 }, () => tokens.generate(32)));
    expect(generated.size).toBe(1000);
  });

  it('carries the requested entropy', () => {
    // 32 bytes → 43 base64url characters.
    expect(tokens.generate(32).length).toBeGreaterThanOrEqual(43);
  });

  it('hashes to a 32-byte digest', () => {
    expect(tokens.hash('any-token').length).toBe(32);
  });

  it('hashes deterministically, which is what makes lookup by hash possible', () => {
    expect(Array.from(tokens.hash('token'))).toEqual(Array.from(tokens.hash('token')));
  });

  it('produces different digests for different tokens', () => {
    expect(Array.from(tokens.hash('token-a'))).not.toEqual(Array.from(tokens.hash('token-b')));
  });

  it('verifies a token against its stored digest', () => {
    const token = tokens.generate(32);
    expect(tokens.verify(token, tokens.hash(token))).toBe(true);
    expect(tokens.verify('other', tokens.hash(token))).toBe(false);
  });

  it('rejects a digest of the wrong length instead of throwing', () => {
    expect(tokens.verify('token', new Uint8Array(16))).toBe(false);
  });
});

describe('UUIDv7 generation', () => {
  const ids = new NodeIdGenerator();

  it('produces well-formed version 7 UUIDs', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(ids.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('produces unique identifiers', () => {
    const generated = new Set(Array.from({ length: 5000 }, () => ids.uuid()));
    expect(generated.size).toBe(5000);
  });

  it('sorts chronologically, including within a single millisecond', () => {
    // The ordering property is the whole reason for v7 over v4. Generating in a
    // tight loop puts many identifiers in the same millisecond, which is
    // exactly where a naive implementation loses ordering — and exactly the
    // rate at which index locality matters.
    const generated = Array.from({ length: 2000 }, () => ids.uuid());
    const sorted = [...generated].sort();
    expect(generated).toEqual(sorted);
  });

  it('keeps 62 bits of randomness, so identifiers stay unguessable', () => {
    const tails = new Set(Array.from({ length: 1000 }, () => ids.uuid().slice(-12)));
    expect(tails.size).toBe(1000);
  });
});
