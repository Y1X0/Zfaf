import { type DomainError, domainError } from '@zfaf/shared';

import { Email } from '../domain/email.js';
import { validatePassword } from '../domain/password-policy.js';
import type { AuthDependencies } from './authenticate.js';
import {
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  RESET_TOKEN_BYTES,
  VERIFICATION_TOKEN_BYTES,
} from '../ports/token-generator.js';
import { RATE_LIMITS } from '../ports/rate-limiter.js';

/**
 * Email verification and password reset.
 *
 * Both are single-use, short-lived, hashed at rest, and — for reset — designed
 * so the endpoint reveals nothing about which addresses have accounts.
 */

export type VerifyEmailResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly error: DomainError };

/**
 * Confirms an address.
 *
 * Verification grants exactly one thing: the ability to publish. It never
 * changes a role or grants any other capability — a verification link that
 * could escalate privilege would make every inbox a path to admin.
 */
export async function verifyEmail(
  rawToken: string,
  deps: AuthDependencies,
): Promise<VerifyEmailResult> {
  const now = deps.clock.now();

  const stored = await deps.verificationTokens.findByTokenHash(
    'email_verification',
    deps.tokens.hash(rawToken),
  );

  if (!stored || stored.usedAt !== null || stored.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, error: domainError('VALIDATION_FAILED') };
  }

  // Single use is enforced by the update's predicate: two simultaneous
  // redemptions cannot both succeed.
  const consumed = await deps.verificationTokens.consume(stored.id, now);
  if (!consumed) return { ok: false, error: domainError('VALIDATION_FAILED') };

  await deps.users.markEmailVerified(stored.userId, now);
  await deps.audit.record(
    {
      actorId: stored.userId,
      actorType: 'user',
      action: 'auth.email_verified',
      resourceType: 'user',
      resourceId: stored.userId,
    },
    now,
  );

  return { ok: true, userId: stored.userId };
}

export type ResendVerificationResult =
  { readonly ok: true } | { readonly ok: false; readonly error: DomainError };

export async function resendVerification(
  userId: string,
  deps: AuthDependencies,
): Promise<ResendVerificationResult> {
  const now = deps.clock.now();

  const verdict = await deps.rateLimiter.consume(
    `verify:resend:${userId}`,
    RATE_LIMITS.verificationResendPerAccount.limit,
    RATE_LIMITS.verificationResendPerAccount.windowMs,
    now,
  );
  if (!verdict.allowed) return { ok: false, error: domainError('RATE_LIMITED') };

  const user = await deps.users.findById(userId);
  if (!user || user.emailVerifiedAt !== null) {
    // Already verified, or no such user: nothing to do, and nothing to disclose.
    return { ok: true };
  }

  // Older links stop working, so only the most recent mail is live.
  await deps.verificationTokens.invalidateAllForUser(userId, 'email_verification', now);

  const token = deps.tokens.generate(VERIFICATION_TOKEN_BYTES);
  await deps.verificationTokens.create({
    id: deps.ids.uuid(),
    userId,
    purpose: 'email_verification',
    tokenHash: deps.tokens.hash(token),
    email: user.email,
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
    now,
  });

  await deps.mail.send({
    to: user.email,
    template: 'email_verification',
    locale: user.locale,
    data: { token, name: user.name ?? '' },
  });

  return { ok: true };
}

export interface RequestPasswordResetInput {
  readonly email: string;
  readonly ipHash: string;
}

/**
 * Starts a password reset.
 *
 * Always succeeds from the caller's point of view, whether or not the address
 * exists. "No account with that email" turns the endpoint into a free lookup
 * service for valid addresses (docs/09 §2.6).
 */
export async function requestPasswordReset(
  input: RequestPasswordResetInput,
  deps: AuthDependencies,
): Promise<{ ok: true } | { ok: false; error: DomainError }> {
  const now = deps.clock.now();

  const ipVerdict = await deps.rateLimiter.consume(
    `reset:ip:${input.ipHash}`,
    RATE_LIMITS.passwordResetPerIp.limit,
    RATE_LIMITS.passwordResetPerIp.windowMs,
    now,
  );
  if (!ipVerdict.allowed) return { ok: false, error: domainError('RATE_LIMITED') };

  const email = Email.parse(input.email);
  if (!email.ok) return { ok: true };

  const accountVerdict = await deps.rateLimiter.consume(
    `reset:account:${email.value.value}`,
    RATE_LIMITS.passwordResetPerAccount.limit,
    RATE_LIMITS.passwordResetPerAccount.windowMs,
    now,
  );
  if (!accountVerdict.allowed) return { ok: true };

  const user = await deps.users.findByEmail(email.value.value);
  if (!user) return { ok: true };

  await deps.verificationTokens.invalidateAllForUser(user.id, 'password_reset', now);

  const token = deps.tokens.generate(RESET_TOKEN_BYTES);
  await deps.verificationTokens.create({
    id: deps.ids.uuid(),
    userId: user.id,
    purpose: 'password_reset',
    tokenHash: deps.tokens.hash(token),
    email: user.email,
    // 15 minutes: this link is a live credential sitting in an inbox.
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
    now,
  });

  await deps.mail.send({
    to: user.email,
    template: 'password_reset',
    locale: user.locale,
    data: { token },
  });

  await deps.audit.record(
    {
      actorId: user.id,
      actorType: 'user',
      action: 'auth.password_reset_requested',
      resourceType: 'user',
      resourceId: user.id,
    },
    now,
  );

  return { ok: true };
}

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
}

export type ResetPasswordResult =
  | { readonly ok: true; readonly userId: string; readonly sessionsRevoked: number }
  | { readonly ok: false; readonly error: DomainError };

/**
 * Completes a password reset.
 *
 * Every existing session is revoked. If the reset was triggered by an attacker
 * who already had a session, leaving it alive would defeat the entire exercise.
 */
export async function resetPassword(
  input: ResetPasswordInput,
  deps: AuthDependencies,
): Promise<ResetPasswordResult> {
  const now = deps.clock.now();

  const password = validatePassword(input.newPassword);
  if (!password.ok) {
    return {
      ok: false,
      error: domainError('VALIDATION_FAILED', {
        details: [{ field: 'password', issue: password.error }],
      }),
    };
  }

  const stored = await deps.verificationTokens.findByTokenHash(
    'password_reset',
    deps.tokens.hash(input.token),
  );

  if (!stored || stored.usedAt !== null || stored.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, error: domainError('VALIDATION_FAILED') };
  }

  const consumed = await deps.verificationTokens.consume(stored.id, now);
  if (!consumed) return { ok: false, error: domainError('VALIDATION_FAILED') };

  const hash = await deps.hasher.hash(input.newPassword);
  await deps.users.updatePasswordHash(stored.userId, hash, now);

  const sessionsRevoked = await deps.sessions.revokeAllForUser(stored.userId, now);

  const user = await deps.users.findById(stored.userId);
  if (user) {
    await deps.mail.send({
      to: user.email,
      template: 'password_changed',
      locale: user.locale,
      data: {},
    });
  }

  await deps.audit.record(
    {
      actorId: stored.userId,
      actorType: 'user',
      action: 'auth.password_reset_completed',
      resourceType: 'user',
      resourceId: stored.userId,
      metadata: { sessionsRevoked },
    },
    now,
  );

  return { ok: true, userId: stored.userId, sessionsRevoked };
}
