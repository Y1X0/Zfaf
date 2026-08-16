import { type Result, err, ok } from '@zfaf/shared';

/**
 * Email address as a value object.
 *
 * Normalisation is what makes uniqueness meaningful: "Ahmad@X.com" and
 * "ahmad@x.com" are the same person, and treating them as two accounts is both
 * a support problem and an account-takeover vector.
 */

export type EmailIssue = 'EMPTY' | 'TOO_LONG' | 'INVALID_FORMAT' | 'DISPOSABLE';

// Deliberately not RFC 5322 exhaustive. A permissive-but-sane pattern plus a
// real delivery check is more useful than a regex nobody can audit.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * Throwaway-mail domains.
 *
 * Small and illustrative rather than exhaustive — a complete list is a
 * maintained data set, not a constant. Blocking these raises the cost of bulk
 * account creation without pretending to be a complete defence.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'throwawaymail.com',
  'yopmail.com',
]);

export class Email {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static parse(
    input: string,
    options: { rejectDisposable?: boolean } = {},
  ): Result<Email, EmailIssue> {
    const normalized = input.normalize('NFKC').trim().toLowerCase();

    if (normalized.length === 0) return err('EMPTY');
    if (normalized.length > MAX_EMAIL_LENGTH) return err('TOO_LONG');
    if (!EMAIL_PATTERN.test(normalized)) return err('INVALID_FORMAT');

    if (options.rejectDisposable === true) {
      const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
      if (DISPOSABLE_DOMAINS.has(domain)) return err('DISPOSABLE');
    }

    return ok(new Email(normalized));
  }

  get domain(): string {
    return this.value.slice(this.value.lastIndexOf('@') + 1);
  }

  /**
   * A form safe to put in a log line.
   *
   * Full addresses are personal data and must not reach logs
   * (docs/15-observability-and-dr.md §2).
   */
  redacted(): string {
    const at = this.value.lastIndexOf('@');
    const local = this.value.slice(0, at);
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${'*'.repeat(Math.max(1, local.length - visible.length))}@${this.domain}`;
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
