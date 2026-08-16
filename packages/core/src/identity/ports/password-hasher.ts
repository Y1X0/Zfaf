/**
 * Password hashing port (docs/09-auth-and-rbac.md §2.3).
 *
 * A port rather than a direct call so the domain stays free of native
 * dependencies, and so the parameters can be raised over time without touching
 * any use case.
 */
export interface PasswordHasher {
  readonly algorithm: string;
  hash(plaintext: string): Promise<string>;
  /** Must be constant-time with respect to the plaintext. */
  verify(hash: string, plaintext: string): Promise<boolean>;
  /** True when the stored hash used weaker parameters and should be upgraded on next sign-in. */
  needsRehash(hash: string): boolean;
}

/**
 * OWASP-recommended argon2id parameters.
 *
 * 19 MiB of memory is the point of argon2id: it makes GPU and ASIC cracking
 * expensive in a way that iteration count alone cannot.
 */
export const ARGON2ID_PARAMETERS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;
