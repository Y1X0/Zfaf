/**
 * Two-factor persistence and the cipher that protects the secret (docs/09 §2.8).
 *
 * A TOTP secret is the one credential in this system that **cannot be hashed**:
 * verification requires the original bytes. So it is encrypted at rest with a
 * key that lives in the secret manager rather than in the database, and the
 * cipher is a port for the same reason every other adapter is — `@zfaf/core` is
 * bundled into the browser and must not import `node:crypto`.
 *
 * The practical consequence is worth stating: a database dump alone does not
 * yield working second factors. It yields ciphertext, and the key is somewhere
 * a database dump is not.
 */

/** Authenticated encryption. An implementation that omits the tag is not one. */
export interface SecretCipher {
  /** Returns nonce ‖ ciphertext ‖ tag. Self-describing, so nothing else stores a nonce. */
  encrypt(plaintext: Uint8Array): Uint8Array;
  /** Returns null when the ciphertext fails authentication — never a guess. */
  decrypt(sealed: Uint8Array): Uint8Array | null;
}

export interface TwoFactorCredentialRecord {
  readonly id: string;
  readonly userId: string;
  /** Encrypted with `SecretCipher`. Plaintext exists only inside a verification. */
  readonly secretSealed: Uint8Array;
  /** Null until the first correct code proves the authenticator was really set up. */
  readonly confirmedAt: Date | null;
  /**
   * The highest TOTP step already accepted for this credential.
   *
   * Persisted rather than kept in memory because replay protection that resets
   * on deploy is replay protection that does not exist.
   */
  readonly lastUsedStep: bigint | null;
  readonly createdAt: Date;
}

export interface NewTwoFactorCredential {
  readonly id: string;
  readonly userId: string;
  readonly secretSealed: Uint8Array;
  readonly now: Date;
}

export interface TwoFactorRepository {
  findByUserId(userId: string): Promise<TwoFactorCredentialRecord | null>;
  /**
   * Starts (or restarts) enrollment.
   *
   * Replaces any unconfirmed credential for the user: somebody who abandoned a
   * setup halfway must be able to begin again. It must **not** replace a
   * confirmed one — that is what `deleteForUser` is for, and it is a separate,
   * separately-audited action.
   */
  upsertUnconfirmed(credential: NewTwoFactorCredential): Promise<TwoFactorCredentialRecord>;
  /**
   * Confirms enrollment, returning false if it was already confirmed.
   * The predicate lives in the UPDATE so two simultaneous confirmations cannot
   * both mint a set of recovery codes.
   */
  confirm(credentialId: string, step: bigint, at: Date): Promise<boolean>;
  /**
   * Records a consumed step, returning false when `step` is not strictly
   * greater than the stored one.
   *
   * Compare-and-set rather than read-then-write: two requests carrying the same
   * code arrive concurrently far more often than intuition suggests, and a
   * read-then-write lets both through.
   */
  recordUsedStep(credentialId: string, step: bigint): Promise<boolean>;
  deleteForUser(userId: string): Promise<boolean>;

  /** Replaces the whole set. Recovery codes are issued and revoked as a batch. */
  replaceRecoveryCodes(userId: string, codeHashes: readonly Uint8Array[], at: Date): Promise<void>;
  /**
   * Consumes one recovery code, returning false when it is unknown or spent.
   * Single-use is enforced by the UPDATE predicate, as with verification tokens.
   */
  consumeRecoveryCode(userId: string, codeHash: Uint8Array, at: Date): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
}
