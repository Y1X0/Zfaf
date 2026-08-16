/**
 * Domain failures, expressed without any knowledge of HTTP.
 *
 * The transport layer owns the mapping from these codes to status codes and
 * localized messages (see docs/04-api-specification.md §3). Keeping the domain
 * unaware of HTTP is what lets the same use cases run behind a queue, a CLI or
 * a future standalone API without change.
 */

export const DOMAIN_ERROR_CODES = [
  // invitation
  'INVITATION_NOT_FOUND',
  'INVITATION_INCOMPLETE',
  'INVITATION_ALREADY_PUBLISHED',
  'INVITATION_NOT_PUBLISHED',
  'INVITATION_EXPIRED',
  'INVITATION_SUSPENDED',
  // slug
  'INVALID_SLUG',
  'SLUG_TAKEN',
  'SLUG_RESERVED',
  // identity & access
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_SUSPENDED',
  // entitlements
  'PLAN_LIMIT_EXCEEDED',
  'FEATURE_NOT_AVAILABLE',
  // rsvp
  'RSVP_CLOSED',
  'RSVP_PARTY_TOO_LARGE',
  'RSVP_DUPLICATE',
  // media
  'MEDIA_TOO_LARGE',
  'MEDIA_TYPE_NOT_ALLOWED',
  'MEDIA_NOT_READY',
  'MEDIA_IN_USE',
  // billing
  'PAYMENTS_NOT_ENABLED',
  // generic
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'CONFLICT',
  'DEPENDENCY_UNAVAILABLE',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainErrorDetail {
  readonly field: string;
  readonly issue: string;
}

export interface DomainError {
  readonly code: DomainErrorCode;
  /** Machine-readable specifics — never a user-facing sentence. */
  readonly details?: readonly DomainErrorDetail[];
  /** Developer-facing context. Never contains secrets or guest data. */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export function domainError(
  code: DomainErrorCode,
  options?: {
    details?: readonly DomainErrorDetail[];
    context?: Readonly<Record<string, string | number | boolean>>;
  },
): DomainError {
  return {
    code,
    ...(options?.details ? { details: options.details } : {}),
    ...(options?.context ? { context: options.context } : {}),
  };
}

export function isDomainErrorCode(value: string): value is DomainErrorCode {
  return (DOMAIN_ERROR_CODES as readonly string[]).includes(value);
}
