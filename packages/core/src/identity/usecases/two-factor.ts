import { type DomainError, domainError } from '@zfaf/shared';

import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import { type Actor, isStaff } from '../../authz/actor.js';
import type { UserRole } from '../../authz/actor.js';
import {
  RECOVERY_CODE_COUNT,
  TOTP_SECRET_BYTES,
  base32Encode,
  isWellFormedRecoveryCode,
  normaliseRecoveryCode,
  otpauthUri,
  recoveryCodeFromBytes,
  verifyTotp,
} from '../domain/totp.js';
import type { TokenGenerator } from '../ports/token-generator.js';
import { RATE_LIMITS, type RateLimiter } from '../ports/rate-limiter.js';
import type {
  SecretCipher,
  TwoFactorCredentialRecord,
  TwoFactorRepository,
} from '../ports/two-factor-repository.js';
import type {
  AuditLogRepository,
  SessionRepository,
  UserRepository,
} from '../ports/identity-repositories.js';

/**
 * Two-factor authentication (docs/09 §2.8, §7 · docs/12 §11).
 *
 * ## What "mandatory" is taken to mean here
 *
 * §2.8 names `admin` and `superadmin`. §7 and the launch checklist in docs/12
 * §11 both say **staff accounts**, which includes `support`. The stricter
 * reading is the one implemented: any account that `isStaff` accepts must hold
 * a confirmed second factor, and a staff session that has not answered its
 * challenge is treated as unauthenticated everywhere — not merely refused at
 * the admin console. A `support` operator can read a customer's account state;
 * that is worth a second factor.
 *
 * ## Where the enforcement lives
 *
 * In `twoFactorGateFor`, called from session resolution — **not** in each
 * route. A per-route check is a list somebody has to remember to add to, and
 * the one entry point that gets forgotten is the whole of the protection. The
 * only endpoints permitted to run under an unsatisfied gate are the two that
 * exist to satisfy it, and they are named in `TWO_FACTOR_EXEMPT_ACTIONS` rather
 * than each deciding for itself.
 */

export interface TwoFactorDependencies {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly twoFactor: TwoFactorRepository;
  readonly audit: AuditLogRepository;
  readonly cipher: SecretCipher;
  readonly tokens: TokenGenerator;
  readonly rateLimiter: RateLimiter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Every staff role. Kept next to the rule it justifies. */
export function twoFactorIsMandatoryFor(role: UserRole): boolean {
  return isStaff({ kind: 'user', role } as Actor);
}

export type TwoFactorGate =
  /** No second factor is required and none is enrolled. */
  | { readonly state: 'NOT_REQUIRED' }
  /** Mandatory for this role, and the account has not finished setting one up. */
  | { readonly state: 'ENROLLMENT_REQUIRED' }
  /** Enrolled, but this session has not answered the challenge. */
  | { readonly state: 'CHALLENGE_REQUIRED' }
  | { readonly state: 'SATISFIED' };

/**
 * The whole policy, as one pure function.
 *
 * Pure so it can be exhaustively tested without a database, and so the same
 * decision is reachable from session resolution, from the admin gate and from
 * a status endpoint without any of them re-deriving it slightly differently.
 */
export function twoFactorGateFor(input: {
  readonly role: UserRole;
  readonly credentialConfirmed: boolean;
  readonly sessionVerifiedAt: Date | null;
}): TwoFactorGate {
  const mandatory = twoFactorIsMandatoryFor(input.role);

  if (!input.credentialConfirmed) {
    return mandatory ? { state: 'ENROLLMENT_REQUIRED' } : { state: 'NOT_REQUIRED' };
  }
  // Enrolled voluntarily or otherwise — once a factor exists it is enforced.
  // An optional second factor that a stolen cookie can skip is decoration.
  return input.sessionVerifiedAt === null
    ? { state: 'CHALLENGE_REQUIRED' }
    : { state: 'SATISFIED' };
}

/**
 * The only routes allowed to run under an unsatisfied gate.
 *
 * Named centrally so the exemption list is one thing to review rather than a
 * property scattered across handlers. Note what is absent: nothing that reads
 * or writes application data.
 */
export const TWO_FACTOR_EXEMPT_ACTIONS = [
  'two_factor.status',
  'two_factor.enroll',
  'two_factor.confirm',
  'two_factor.verify',
  'auth.logout',
] as const;

export type TwoFactorExemptAction = (typeof TWO_FACTOR_EXEMPT_ACTIONS)[number];

// ── enrollment ──────────────────────────────────────────────────────────────

export interface EnrollmentStarted {
  /** Base32, for a person typing it in by hand. */
  readonly secret: string;
  /** The `otpauth://` URI behind the QR code. */
  readonly uri: string;
}

export type EnrollResult =
  | { readonly ok: true; readonly value: EnrollmentStarted }
  | { readonly ok: false; readonly error: DomainError };

/**
 * Begins enrollment, producing a secret that does not work yet.
 *
 * The credential is written unconfirmed. Until a correct code proves the
 * authenticator really holds the secret, nothing about the account changes —
 * otherwise a mistyped setup locks an operator out of the console permanently,
 * which is the failure mode that makes teams disable 2FA.
 *
 * Restarting is allowed and replaces the pending secret. Restarting when a
 * *confirmed* credential exists is refused: rotating a working second factor
 * must go through `disableTwoFactor`, which is separately authorised and
 * separately audited.
 */
export async function beginTwoFactorEnrollment(
  actor: Actor,
  deps: TwoFactorDependencies,
): Promise<EnrollResult> {
  if (actor.kind !== 'user') return { ok: false, error: domainError('FORBIDDEN') };
  const now = deps.clock.now();

  const user = await deps.users.findById(actor.userId);
  if (!user) return { ok: false, error: domainError('UNAUTHENTICATED') };

  const existing = await deps.twoFactor.findByUserId(user.id);
  if (existing?.confirmedAt) {
    return {
      ok: false,
      error: domainError('CONFLICT', { context: { reason: 'already_enrolled' } }),
    };
  }

  const secret = deps.tokens.randomBytes(TOTP_SECRET_BYTES);
  await deps.twoFactor.upsertUnconfirmed({
    id: existing?.id ?? deps.ids.uuid(),
    userId: user.id,
    secretSealed: deps.cipher.encrypt(secret),
    now,
  });

  await deps.audit.record(
    {
      actorId: user.id,
      actorType: 'user',
      action: 'two_factor.enrollment_started',
      resourceType: 'user',
      resourceId: user.id,
    },
    now,
  );

  return {
    ok: true,
    value: {
      secret: base32Encode(secret),
      uri: otpauthUri({ secret, account: user.email, issuer: 'Zfaf' }),
    },
  };
}

export interface EnrollmentConfirmed {
  /** Shown exactly once. Only hashes are kept. */
  readonly recoveryCodes: readonly string[];
}

export type ConfirmResult =
  | { readonly ok: true; readonly value: EnrollmentConfirmed }
  | { readonly ok: false; readonly error: DomainError };

/**
 * Completes enrollment against a code from the authenticator.
 *
 * Confirming also **verifies the current session**: the person just proved
 * possession, and making them immediately answer a second challenge would be
 * ceremony rather than security.
 */
export async function confirmTwoFactorEnrollment(
  actor: Actor,
  code: string,
  deps: TwoFactorDependencies,
): Promise<ConfirmResult> {
  if (actor.kind !== 'user') return { ok: false, error: domainError('FORBIDDEN') };
  const now = deps.clock.now();

  const throttled = await consumeAttemptBudget(actor, deps, now);
  if (throttled) return { ok: false, error: throttled };

  const credential = await deps.twoFactor.findByUserId(actor.userId);
  if (!credential) {
    return { ok: false, error: domainError('CONFLICT', { context: { reason: 'not_enrolled' } }) };
  }
  if (credential.confirmedAt) {
    return {
      ok: false,
      error: domainError('CONFLICT', { context: { reason: 'already_enrolled' } }),
    };
  }

  const secret = openSecret(credential, deps);
  if (!secret) return { ok: false, error: domainError('DEPENDENCY_UNAVAILABLE') };

  const verdict = verifyTotp({ secret, code, now, lastUsedStep: null });
  if (!verdict.ok) {
    await recordFailure(actor.userId, 'two_factor.enrollment_failed', verdict.reason, deps, now);
    return {
      ok: false,
      error: domainError('UNAUTHENTICATED', { context: { reason: 'invalid_code' } }),
    };
  }

  const confirmed = await deps.twoFactor.confirm(credential.id, BigInt(verdict.step), now);
  if (!confirmed) {
    return {
      ok: false,
      error: domainError('CONFLICT', { context: { reason: 'already_enrolled' } }),
    };
  }

  const codes = mintRecoveryCodes(deps);
  await deps.twoFactor.replaceRecoveryCodes(
    actor.userId,
    codes.map((recoveryCode) => deps.tokens.hash(normaliseRecoveryCode(recoveryCode))),
    now,
  );

  if (actor.sessionId) await deps.sessions.markTwoFactorVerified(actor.sessionId, now);

  /**
   * Everything else signs out.
   *
   * A session that predates the second factor never answered a challenge, and
   * leaving those alive would mean enrolling changes nothing for whoever
   * already holds a stolen cookie.
   */
  const revoked = await deps.sessions.revokeAllForUser(
    actor.userId,
    now,
    actor.sessionId ?? undefined,
  );

  await deps.audit.record(
    {
      actorId: actor.userId,
      actorType: 'user',
      action: 'two_factor.enrolled',
      resourceType: 'user',
      resourceId: actor.userId,
      metadata: { recoveryCodes: codes.length, otherSessionsRevoked: revoked },
    },
    now,
  );

  return { ok: true, value: { recoveryCodes: codes } };
}

// ── the login challenge ─────────────────────────────────────────────────────

export type ChallengeOutcome = 'TOTP' | 'RECOVERY_CODE';

export type VerifyResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly method: ChallengeOutcome;
        readonly recoveryCodesRemaining: number;
      };
    }
  | { readonly ok: false; readonly error: DomainError };

/**
 * Answers the challenge for the current session.
 *
 * Accepts either a TOTP code or a recovery code, and does not say which one it
 * was expecting when both fail — the response is identical, because telling a
 * caller "that was a valid recovery code format but wrong" is a hint.
 */
export async function verifyTwoFactorChallenge(
  actor: Actor,
  code: string,
  deps: TwoFactorDependencies,
): Promise<VerifyResult> {
  if (actor.kind !== 'user' || !actor.sessionId) {
    return { ok: false, error: domainError('FORBIDDEN') };
  }
  const now = deps.clock.now();

  const throttled = await consumeAttemptBudget(actor, deps, now);
  if (throttled) return { ok: false, error: throttled };

  const credential = await deps.twoFactor.findByUserId(actor.userId);
  if (!credential?.confirmedAt) {
    return { ok: false, error: domainError('CONFLICT', { context: { reason: 'not_enrolled' } }) };
  }

  // A recovery code is tried first only because it is unambiguous by shape; a
  // six-digit TOTP can never satisfy `isWellFormedRecoveryCode`.
  if (isWellFormedRecoveryCode(code)) {
    const consumed = await deps.twoFactor.consumeRecoveryCode(
      actor.userId,
      deps.tokens.hash(normaliseRecoveryCode(code)),
      now,
    );
    if (!consumed) {
      await recordFailure(
        actor.userId,
        'two_factor.challenge_failed',
        'RECOVERY_INVALID',
        deps,
        now,
      );
      return {
        ok: false,
        error: domainError('UNAUTHENTICATED', { context: { reason: 'invalid_code' } }),
      };
    }

    await deps.sessions.markTwoFactorVerified(actor.sessionId, now);
    const remaining = await deps.twoFactor.countUnusedRecoveryCodes(actor.userId);
    await deps.audit.record(
      {
        actorId: actor.userId,
        actorType: 'user',
        action: 'two_factor.challenge_passed',
        resourceType: 'session',
        resourceId: actor.sessionId,
        metadata: { method: 'recovery_code', remaining },
      },
      now,
    );
    return { ok: true, value: { method: 'RECOVERY_CODE', recoveryCodesRemaining: remaining } };
  }

  const secret = openSecret(credential, deps);
  if (!secret) return { ok: false, error: domainError('DEPENDENCY_UNAVAILABLE') };

  const verdict = verifyTotp({
    secret,
    code,
    now,
    lastUsedStep: credential.lastUsedStep === null ? null : Number(credential.lastUsedStep),
  });
  if (!verdict.ok) {
    await recordFailure(actor.userId, 'two_factor.challenge_failed', verdict.reason, deps, now);
    return {
      ok: false,
      error: domainError('UNAUTHENTICATED', { context: { reason: 'invalid_code' } }),
    };
  }

  /**
   * The step is claimed **before** the session is marked verified.
   *
   * `recordUsedStep` is a compare-and-set, so of two requests carrying the same
   * code exactly one wins. Doing it the other way round would verify both
   * sessions and then discover the conflict.
   */
  const claimed = await deps.twoFactor.recordUsedStep(credential.id, BigInt(verdict.step));
  if (!claimed) {
    await recordFailure(actor.userId, 'two_factor.challenge_failed', 'REPLAYED', deps, now);
    return {
      ok: false,
      error: domainError('UNAUTHENTICATED', { context: { reason: 'invalid_code' } }),
    };
  }

  await deps.sessions.markTwoFactorVerified(actor.sessionId, now);
  await deps.audit.record(
    {
      actorId: actor.userId,
      actorType: 'user',
      action: 'two_factor.challenge_passed',
      resourceType: 'session',
      resourceId: actor.sessionId,
      metadata: { method: 'totp' },
    },
    now,
  );

  const remaining = await deps.twoFactor.countUnusedRecoveryCodes(actor.userId);
  return { ok: true, value: { method: 'TOTP', recoveryCodesRemaining: remaining } };
}

// ── removal ─────────────────────────────────────────────────────────────────

export type DisableResult =
  { readonly ok: true } | { readonly ok: false; readonly error: DomainError };

/**
 * Removes a second factor.
 *
 * Refused outright for staff: "mandatory, no exception" would mean nothing if
 * the holder could switch it off. A staff member who has lost their
 * authenticator uses a recovery code; one who has lost both needs another
 * operator and the `restore-backup`-adjacent runbook, which is a deliberate
 * cost rather than an oversight.
 */
export async function disableTwoFactor(
  actor: Actor,
  code: string,
  deps: TwoFactorDependencies,
): Promise<DisableResult> {
  if (actor.kind !== 'user') return { ok: false, error: domainError('FORBIDDEN') };
  const now = deps.clock.now();

  const user = await deps.users.findById(actor.userId);
  if (!user) return { ok: false, error: domainError('UNAUTHENTICATED') };
  if (twoFactorIsMandatoryFor(user.role)) {
    await deps.audit.record(
      {
        actorId: actor.userId,
        actorType: 'user',
        action: 'two_factor.disable_refused',
        resourceType: 'user',
        resourceId: actor.userId,
        metadata: { reason: 'mandatory_for_role', role: user.role },
      },
      now,
    );
    return {
      ok: false,
      error: domainError('FORBIDDEN', { context: { reason: 'mandatory_for_role' } }),
    };
  }

  // Proving possession before removal, so a stolen session cannot strip the
  // factor that would have stopped it.
  const verified = await verifyTwoFactorChallenge(actor, code, deps);
  if (!verified.ok) return { ok: false, error: verified.error };

  await deps.twoFactor.deleteForUser(actor.userId);
  await deps.audit.record(
    {
      actorId: actor.userId,
      actorType: 'user',
      action: 'two_factor.disabled',
      resourceType: 'user',
      resourceId: actor.userId,
    },
    now,
  );
  return { ok: true };
}

// ── status ──────────────────────────────────────────────────────────────────

export interface TwoFactorStatus {
  readonly enrolled: boolean;
  readonly mandatory: boolean;
  readonly gate: TwoFactorGate['state'];
  readonly recoveryCodesRemaining: number;
}

export async function twoFactorStatus(
  actor: Actor,
  sessionVerifiedAt: Date | null,
  deps: TwoFactorDependencies,
): Promise<TwoFactorStatus | null> {
  if (actor.kind !== 'user') return null;
  const user = await deps.users.findById(actor.userId);
  if (!user) return null;

  const credential = await deps.twoFactor.findByUserId(user.id);
  const enrolled = credential?.confirmedAt != null;

  return {
    enrolled,
    mandatory: twoFactorIsMandatoryFor(user.role),
    gate: twoFactorGateFor({
      role: user.role,
      credentialConfirmed: enrolled,
      sessionVerifiedAt,
    }).state,
    recoveryCodesRemaining: enrolled ? await deps.twoFactor.countUnusedRecoveryCodes(user.id) : 0,
  };
}

// ── shared internals ────────────────────────────────────────────────────────

function openSecret(
  credential: TwoFactorCredentialRecord,
  deps: TwoFactorDependencies,
): Uint8Array | null {
  // A null here means the ciphertext failed authentication — a wrong key, or a
  // tampered row. Neither is a reason to fall back to anything.
  return deps.cipher.decrypt(credential.secretSealed);
}

function mintRecoveryCodes(deps: TwoFactorDependencies): readonly string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    recoveryCodeFromBytes(deps.tokens.randomBytes(16)),
  );
}

async function consumeAttemptBudget(
  actor: Actor & { kind: 'user' },
  deps: TwoFactorDependencies,
  now: Date,
): Promise<DomainError | null> {
  const budgets: ReadonlyArray<readonly [string, { limit: number; windowMs: number }]> = [
    [`2fa:account:${actor.userId}`, RATE_LIMITS.twoFactorPerAccount],
    ...(actor.sessionId
      ? ([[`2fa:session:${actor.sessionId}`, RATE_LIMITS.twoFactorPerSession]] as const)
      : []),
  ];

  for (const [key, budget] of budgets) {
    const verdict = await deps.rateLimiter.consume(key, budget.limit, budget.windowMs, now);
    if (!verdict.allowed) return domainError('RATE_LIMITED');
  }
  return null;
}

async function recordFailure(
  userId: string,
  action: string,
  reason: string,
  deps: TwoFactorDependencies,
  now: Date,
): Promise<void> {
  await deps.audit.record(
    {
      actorId: userId,
      actorType: 'user',
      action,
      resourceType: 'user',
      resourceId: userId,
      // The reason, never the code. A rejected code in an audit log is a
      // rejected code an attacker can read out of an audit log.
      metadata: { reason },
    },
    now,
  );
}
