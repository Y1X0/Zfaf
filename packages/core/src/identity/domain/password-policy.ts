import { type Result, err, ok } from '@zfaf/shared';

/**
 * Password policy (docs/09-auth-and-rbac.md §2.3).
 *
 * Length over composition rules. Forced complexity reliably produces
 * `P@ssw0rd1!` — memorable to nobody, guessable by everyone — while length is
 * what actually resists offline cracking.
 */

export const MIN_PASSWORD_LENGTH = 10;
// bcrypt's 72-byte truncation does not apply to argon2id, but an unbounded
// password is a denial-of-service vector against the hasher.
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordIssue = 'TOO_SHORT' | 'TOO_LONG' | 'BREACHED' | 'TOO_COMMON';

/**
 * Passwords rejected regardless of length.
 *
 * The real defence is the breach-corpus check behind `BreachedPasswordChecker`;
 * this catches the most common choices without a network round trip.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password',
  'password123',
  '123456789',
  'qwertyuiop',
  'letmein123',
  'welcome123',
  'admin12345',
  'iloveyou12',
  '1234567890',
]);

export interface PasswordStrength {
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly label: 'very-weak' | 'weak' | 'fair' | 'good' | 'strong';
}

/**
 * Validates a candidate password.
 *
 * Takes the breach verdict as an argument rather than performing the lookup:
 * the domain stays free of I/O, and the caller controls whether a slow external
 * check runs at all.
 */
export function validatePassword(
  password: string,
  options: { knownBreached?: boolean } = {},
): Result<string, PasswordIssue> {
  if (password.length < MIN_PASSWORD_LENGTH) return err('TOO_SHORT');
  if (password.length > MAX_PASSWORD_LENGTH) return err('TOO_LONG');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return err('TOO_COMMON');
  if (options.knownBreached === true) return err('BREACHED');
  return ok(password);
}

/**
 * A rough strength signal for the UI.
 *
 * Advisory only: it shapes the meter shown to the user and never gates
 * submission, because a strength estimator that blocks real passphrases is
 * worse than none.
 */
export function estimateStrength(password: string): PasswordStrength {
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/\s/.test(password) && password.length >= 15) score += 1; // passphrases
  if (new Set(password).size >= 10) score += 1;

  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const labels = ['very-weak', 'weak', 'fair', 'good', 'strong'] as const;
  return { score: clamped, label: labels[clamped] as PasswordStrength['label'] };
}
