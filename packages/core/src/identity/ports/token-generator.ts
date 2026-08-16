/**
 * Token generation and hashing (ADR-0006).
 *
 * Every token the system issues — session, email verification, password reset —
 * is stored hashed. The plaintext exists only in the response that delivers it
 * and in the user's browser or inbox.
 */
export interface TokenGenerator {
  /** Cryptographically secure random token, URL-safe. */
  generate(bytes: number): string;
  /**
   * Cryptographically secure raw bytes.
   *
   * Separate from `generate` because a TOTP secret is *bytes*, not text: the
   * base32 an authenticator reads is an encoding of the same 20 bytes the HMAC
   * consumes, and deriving them from a URL-safe string would silently shrink
   * the entropy to whatever that alphabet carries.
   */
  randomBytes(count: number): Uint8Array;
  /** SHA-256 of the token. What actually goes in the database. */
  hash(token: string): Uint8Array;
  /** Constant-time comparison, so verification cannot be timed. */
  verify(token: string, storedHash: Uint8Array): boolean;
}

export const VERIFICATION_TOKEN_BYTES = 32;
export const RESET_TOKEN_BYTES = 32;

/** Verification links stay usable for a day; people do not check mail instantly. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Reset links expire in 15 minutes. A password reset link is a live credential
 * sitting in an inbox, and inboxes are the most commonly compromised surface a
 * user has (docs/09 §2.6).
 */
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
