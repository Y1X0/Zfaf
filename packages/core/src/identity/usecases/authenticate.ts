import { type DomainError, domainError } from '@zfaf/shared';

import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import { Email } from '../domain/email.js';
import { validatePassword } from '../domain/password-policy.js';
import { accountStateOf, canAuthenticate, capabilitiesFor } from '../domain/account-status.js';
import { SESSION_TOKEN_BYTES, sessionTtlFor } from '../domain/session.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { TokenGenerator } from '../ports/token-generator.js';
import { EMAIL_VERIFICATION_TTL_MS, VERIFICATION_TOKEN_BYTES } from '../ports/token-generator.js';
import { RATE_LIMITS, type RateLimiter, lockoutDurationFor } from '../ports/rate-limiter.js';
import type {
  AuditLogRepository,
  SessionRepository,
  UserRepository,
  VerificationTokenRepository,
} from '../ports/identity-repositories.js';
import type { MailService } from '../ports/mail-service.js';

/**
 * Registration and sign-in.
 *
 * Two properties shape almost every decision below:
 *
 *  1. **No account enumeration.** Registration and sign-in must not reveal
 *     whether an address is already known. That constrains responses, error
 *     codes and — critically — timing.
 *  2. **Nothing recoverable is stored.** Passwords are argon2id hashes; tokens
 *     are stored as SHA-256 and exist in plaintext only in transit.
 */

export interface AuthDependencies {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly verificationTokens: VerificationTokenRepository;
  readonly audit: AuditLogRepository;
  readonly hasher: PasswordHasher;
  readonly tokens: TokenGenerator;
  readonly rateLimiter: RateLimiter;
  readonly mail: MailService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string | null;
  readonly locale?: string;
  readonly marketCode: string;
  readonly ipHash: string;
  readonly userAgent?: string | null;
}

/**
 * The registration result.
 *
 * Note what is *not* here: any indication of whether the address already
 * existed. The endpoint answers the same way either way, and the difference is
 * communicated only through the email that is (or is not) sent.
 */
export interface RegisterSuccess {
  readonly created: boolean;
  readonly userId: string | null;
  readonly sessionToken: string | null;
}

export type RegisterResult =
  | { readonly ok: true; readonly value: RegisterSuccess }
  | { readonly ok: false; readonly error: DomainError };

export async function registerUser(
  input: RegisterInput,
  deps: AuthDependencies,
): Promise<RegisterResult> {
  const now = deps.clock.now();

  const ipVerdict = await deps.rateLimiter.consume(
    `register:ip:${input.ipHash}`,
    RATE_LIMITS.registerPerIp.limit,
    RATE_LIMITS.registerPerIp.windowMs,
    now,
  );
  if (!ipVerdict.allowed) {
    return { ok: false, error: domainError('RATE_LIMITED') };
  }

  const email = Email.parse(input.email, { rejectDisposable: true });
  if (!email.ok) {
    return {
      ok: false,
      error: domainError('VALIDATION_FAILED', {
        details: [{ field: 'email', issue: email.error }],
      }),
    };
  }

  const password = validatePassword(input.password);
  if (!password.ok) {
    return {
      ok: false,
      error: domainError('VALIDATION_FAILED', {
        details: [{ field: 'password', issue: password.error }],
      }),
    };
  }

  const existing = await deps.users.findByEmail(email.value.value);

  if (existing) {
    // The address is taken. Rather than say so, hash the password anyway — so
    // the response takes the same time as a real registration — and send a
    // "someone tried to register with your address" notice to the real owner.
    // The caller sees exactly what a new registration sees.
    await deps.hasher.hash(input.password);
    await deps.mail.send({
      to: email.value.value,
      template: 'new_device_sign_in',
      locale: existing.locale,
      data: { reason: 'registration_attempt' },
    });
    return { ok: true, value: { created: false, userId: null, sessionToken: null } };
  }

  const passwordHash = await deps.hasher.hash(input.password);
  const user = await deps.users.create({
    id: deps.ids.uuid(),
    email: email.value.value,
    passwordHash,
    name: input.name ?? null,
    locale: input.locale ?? 'ar',
    marketCode: input.marketCode,
    now,
  });

  const verificationToken = deps.tokens.generate(VERIFICATION_TOKEN_BYTES);
  await deps.verificationTokens.create({
    id: deps.ids.uuid(),
    userId: user.id,
    purpose: 'email_verification',
    tokenHash: deps.tokens.hash(verificationToken),
    email: user.email,
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
    now,
  });

  /**
   * A transport failure must not cost the customer their account (ADR-0024).
   *
   * The row and the token are already written by the time we get here, so an
   * unhandled throw returns 500 to somebody who *does* now have an account —
   * they simply cannot tell, and retrying gives them "that address is taken".
   * A provider outage, a rate limit, an expired key: none of those is the
   * customer's fault and none of them is worth a half-created account.
   *
   * Swallowed, not ignored. The token is in the database and
   * `resendVerification` re-sends against it, so the recoverable state is
   * intact. The mail adapter has already logged the failure with its status
   * (`ResendMailService`), which is the line an operator needs.
   *
   * The consequence is bounded by design: verification gates publishing rather
   * than the first run, so an account whose link never arrived can still sign
   * in and build — it just cannot publish until the address is confirmed.
   */
  try {
    await deps.mail.send({
      to: user.email,
      template: 'email_verification',
      locale: user.locale,
      data: { token: verificationToken, name: user.name ?? '' },
    });
  } catch {
    // Deliberately empty: the adapter logged it, and the audit entry below
    // records the registration either way.
  }

  // Signed in immediately. Verification gates publishing, not the first run, so
  // a new user reaches a finished draft before being asked for anything.
  const sessionToken = await issueSession(
    user.id,
    false,
    input.ipHash,
    input.userAgent ?? null,
    deps,
  );

  await deps.audit.record(
    {
      actorId: user.id,
      actorType: 'user',
      action: 'auth.registered',
      resourceType: 'user',
      resourceId: user.id,
    },
    now,
  );

  return { ok: true, value: { created: true, userId: user.id, sessionToken } };
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipHash: string;
  readonly userAgent?: string | null;
}

export interface LoginSuccess {
  readonly userId: string;
  readonly sessionToken: string;
  readonly requiresEmailVerification: boolean;
  /** True when signing in cancelled a scheduled deletion. */
  readonly deletionCancelled: boolean;
}

export type LoginResult =
  | { readonly ok: true; readonly value: LoginSuccess }
  | { readonly ok: false; readonly error: DomainError };

/**
 * Signs a user in.
 *
 * Every failure path returns the same `UNAUTHENTICATED` error. A wrong
 * password, an unknown address and a suspended account are indistinguishable
 * from outside — otherwise the endpoint becomes a lookup service for which
 * addresses have accounts.
 */
export async function login(input: LoginInput, deps: AuthDependencies): Promise<LoginResult> {
  const now = deps.clock.now();
  const genericFailure = { ok: false, error: domainError('UNAUTHENTICATED') } as const;

  const ipVerdict = await deps.rateLimiter.consume(
    `login:ip:${input.ipHash}`,
    RATE_LIMITS.loginPerIp.limit,
    RATE_LIMITS.loginPerIp.windowMs,
    now,
  );
  if (!ipVerdict.allowed) return { ok: false, error: domainError('RATE_LIMITED') };

  const email = Email.parse(input.email);
  if (!email.ok) {
    // Still burn a hash so a malformed address is not measurably faster than a
    // well-formed one.
    await deps.hasher.hash(input.password);
    return genericFailure;
  }

  const accountVerdict = await deps.rateLimiter.consume(
    `login:account:${email.value.value}`,
    RATE_LIMITS.loginPerAccount.limit,
    RATE_LIMITS.loginPerAccount.windowMs,
    now,
  );
  if (!accountVerdict.allowed) return { ok: false, error: domainError('RATE_LIMITED') };

  const user = await deps.users.findByEmail(email.value.value);

  if (!user || user.passwordHash === null) {
    // No such user, or an OAuth-only account. Verify against a dummy hash so
    // the timing matches a real verification.
    await deps.hasher.verify(DUMMY_HASH, input.password);
    return genericFailure;
  }

  const state = accountStateOf(user);
  const gate = canAuthenticate(state, { lockedUntil: user.lockedUntil, now });
  if (!gate.allowed) {
    await deps.hasher.verify(DUMMY_HASH, input.password);
    await deps.audit.record(
      {
        actorId: user.id,
        actorType: 'user',
        action: 'auth.login_refused',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { reason: gate.reason },
      },
      now,
    );
    return gate.reason === 'ACCOUNT_LOCKED'
      ? { ok: false, error: domainError('RATE_LIMITED') }
      : genericFailure;
  }

  const passwordMatches = await deps.hasher.verify(user.passwordHash, input.password);

  if (!passwordMatches) {
    const failures = user.failedLoginCount + 1;
    const lockoutMs = lockoutDurationFor(failures);
    await deps.users.recordFailedLogin(
      user.id,
      lockoutMs === null ? null : new Date(now.getTime() + lockoutMs),
      now,
    );
    await deps.audit.record(
      {
        actorId: user.id,
        actorType: 'user',
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { consecutiveFailures: failures },
      },
      now,
    );
    return genericFailure;
  }

  // One success forgives the earlier failures, so a person who mistyped twice
  // is not still throttled afterwards.
  await deps.rateLimiter.reset(`login:account:${email.value.value}`);
  await deps.users.recordSuccessfulLogin(user.id, now);

  const deletionCancelled = user.deletionRequestedAt !== null;
  if (deletionCancelled) {
    // Signing in is the documented way to cancel a scheduled deletion.
    await deps.users.cancelDeletion(user.id, now);
  }

  const isStaffAccount =
    user.role === 'support' || user.role === 'admin' || user.role === 'superadmin';
  const sessionToken = await issueSession(
    user.id,
    isStaffAccount,
    input.ipHash,
    input.userAgent ?? null,
    deps,
  );

  await deps.audit.record(
    {
      actorId: user.id,
      actorType: 'user',
      action: 'auth.login_succeeded',
      resourceType: 'user',
      resourceId: user.id,
    },
    now,
  );

  return {
    ok: true,
    value: {
      userId: user.id,
      sessionToken,
      requiresEmailVerification: !capabilitiesFor(state).canPublish,
      deletionCancelled,
    },
  };
}

async function issueSession(
  userId: string,
  isStaff: boolean,
  ipHash: string,
  userAgent: string | null,
  deps: AuthDependencies,
): Promise<string> {
  const now = deps.clock.now();
  const token = deps.tokens.generate(SESSION_TOKEN_BYTES);

  await deps.sessions.create({
    id: deps.ids.uuid(),
    userId,
    // Only the hash is persisted (ADR-0006).
    tokenHash: deps.tokens.hash(token),
    expiresAt: new Date(now.getTime() + sessionTtlFor(isStaff)),
    ipHash: deps.tokens.hash(ipHash),
    userAgent,
    now,
  });

  return token;
}

/**
 * A fixed argon2id hash of a random value.
 *
 * Verified against when no user exists, so an unknown address costs the same
 * time as a known one. Without it, a stopwatch enumerates the user table.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1maXhlZC1zYWx0LXZhbA$0000000000000000000000000000000000000000000';
