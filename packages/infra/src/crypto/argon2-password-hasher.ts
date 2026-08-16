import { hash, verify } from '@node-rs/argon2';

import { ARGON2ID_PARAMETERS, type PasswordHasher } from '@zfaf/core';

/**
 * argon2id password hashing (docs/09-auth-and-rbac.md §2.3).
 *
 * argon2id rather than bcrypt because it is memory-hard: the 19 MiB working set
 * is what makes GPU and ASIC cracking expensive, which iteration count alone
 * cannot achieve.
 *
 * Parameters are embedded in the stored PHC string, so raising them later
 * upgrades existing users transparently on their next sign-in via `needsRehash`.
 */

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2`.
 *
 * Written as a literal because the package exports it as an ambient const enum,
 * which cannot be read under `verbatimModuleSyntax`. The value is fixed by the
 * argon2 specification's type ordering (d = 0, i = 1, id = 2), so it is stable.
 */
const ARGON2ID = 2;

/** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` */
const PHC_PATTERN = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

export class Argon2PasswordHasher implements PasswordHasher {
  readonly algorithm = 'argon2id';

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, {
      algorithm: ARGON2ID,
      memoryCost: ARGON2ID_PARAMETERS.memoryCost,
      timeCost: ARGON2ID_PARAMETERS.timeCost,
      parallelism: ARGON2ID_PARAMETERS.parallelism,
    });
  }

  /**
   * Verifies a password.
   *
   * Returns false rather than throwing on a malformed hash: a stored value that
   * cannot be parsed must fail closed, and must not be distinguishable by the
   * caller from a wrong password.
   */
  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * Whether a stored hash was produced with weaker parameters.
   *
   * Implemented by parsing the PHC string rather than delegating, because
   * `@node-rs/argon2` exposes no such helper. Callers use it to re-hash on the
   * next successful sign-in, which is how a parameter increase reaches existing
   * users without asking anyone to change their password.
   */
  needsRehash(storedHash: string): boolean {
    const match = PHC_PATTERN.exec(storedHash);
    // A different algorithm, or something unparseable: rehash on next sign-in.
    if (!match) return true;

    const memoryCost = Number(match[2]);
    const timeCost = Number(match[3]);
    const parallelism = Number(match[4]);

    return (
      memoryCost < ARGON2ID_PARAMETERS.memoryCost ||
      timeCost < ARGON2ID_PARAMETERS.timeCost ||
      parallelism !== ARGON2ID_PARAMETERS.parallelism
    );
  }
}
