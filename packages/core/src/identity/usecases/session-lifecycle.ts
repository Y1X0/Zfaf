import { type DomainError, domainError } from '@zfaf/shared';

import type { Clock } from '../../ports/clock.js';
import type { Actor } from '../../authz/actor.js';
import { accountStateOf, capabilitiesFor } from '../domain/account-status.js';
import { type SessionRejection, evaluateSession } from '../domain/session.js';
import type { TokenGenerator } from '../ports/token-generator.js';
import type {
  AuditLogRepository,
  MembershipRepository,
  SessionRepository,
  UserRepository,
} from '../ports/identity-repositories.js';
import type { TwoFactorRepository } from '../ports/two-factor-repository.js';
import { type TwoFactorGate, twoFactorGateFor } from './two-factor.js';

/**
 * Turning a cookie into an `Actor`, and ending sessions.
 *
 * This is the bridge between the transport layer and everything M1 built: the
 * `Actor` produced here is what `can()` and `tenantScopeFor()` consume, so the
 * authorization model added in M1 is reached through exactly one door.
 *
 * The account's current state is read on **every** request rather than baked
 * into the session. That is the whole point of database sessions: suspending an
 * account takes effect on the attacker's next request, not when their token
 * happens to expire (ADR-0006).
 */

export interface SessionDependencies {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly memberships: MembershipRepository;
  readonly audit: AuditLogRepository;
  /**
   * Required, not optional, and that is the point.
   *
   * An optional second-factor repository is a second-factor check that silently
   * does nothing wherever somebody forgot to pass it — and the place it gets
   * forgotten is the place that needed it.
   */
  readonly twoFactor: TwoFactorRepository;
  readonly tokens: TokenGenerator;
  readonly clock: Clock;
}

export type ResolveSessionFailure = SessionRejection | 'ACCOUNT_NOT_USABLE' | 'MALFORMED_TOKEN';

export type ResolveSessionResult =
  | {
      readonly ok: true;
      readonly actor: Actor;
      readonly sessionId: string;
      /**
       * When the caller signed in.
       *
       * Carried up so the admin routes can require a *recent* sign-in
       * (docs/04 §10): a session extended over three weeks of ordinary use is
       * a valid session, but it is not proof that the person at the keyboard
       * is still the person who authenticated. Ordinary routes ignore this.
       */
      readonly sessionStartedAt: Date;
      /**
       * Whether this session has satisfied its second factor (docs/09 §2.8).
       *
       * Returned rather than enforced here, because exactly two callers must be
       * able to proceed without it: the challenge endpoint and the enrollment
       * endpoints. Everything else refuses on anything but `SATISFIED` or
       * `NOT_REQUIRED` — see `requireActor` in the web app.
       */
      readonly twoFactor: TwoFactorGate;
    }
  | { readonly ok: false; readonly reason: ResolveSessionFailure };

/**
 * Resolves a session token into an authenticated actor.
 *
 * Memberships are loaded from the database here, which is what makes
 * `resolveTenantContext` able to reject a forged tenant id: the comparison is
 * against server-side truth, never against anything the client sent.
 */
export async function resolveSession(
  rawToken: string | null | undefined,
  deps: SessionDependencies,
): Promise<ResolveSessionResult> {
  if (typeof rawToken !== 'string' || rawToken.length < 16 || rawToken.length > 512) {
    return { ok: false, reason: 'MALFORMED_TOKEN' };
  }

  const now = deps.clock.now();
  const stored = await deps.sessions.findByTokenHash(deps.tokens.hash(rawToken));

  const verdict = evaluateSession(stored, now);
  if (!verdict.valid) return { ok: false, reason: verdict.reason };
  if (!stored) return { ok: false, reason: 'NOT_FOUND' };

  const user = await deps.users.findById(stored.userId);
  if (!user) return { ok: false, reason: 'NOT_FOUND' };

  const state = accountStateOf(user);
  if (!capabilitiesFor(state).canHoldSession) {
    // A suspension mid-session ends it immediately, rather than waiting for the
    // token to expire.
    await deps.sessions.revoke(stored.id, now);
    return { ok: false, reason: 'ACCOUNT_NOT_USABLE' };
  }

  if (verdict.shouldExtend) {
    await deps.sessions.touch(stored.id, now, verdict.newExpiresAt);
  }

  const memberships = await deps.memberships.listForUser(user.id);
  const credential = await deps.twoFactor.findByUserId(user.id);
  const twoFactor = twoFactorGateFor({
    role: user.role,
    credentialConfirmed: credential?.confirmedAt != null,
    sessionVerifiedAt: stored.twoFactorVerifiedAt,
  });

  const actor: Actor = {
    kind: 'user',
    userId: user.id,
    role: user.role,
    emailVerified: user.emailVerifiedAt !== null,
    status: user.status,
    sessionId: stored.id,
    memberships: memberships
      .filter((membership) => membership.acceptedAt !== null)
      .map((membership) => ({ invitationId: membership.invitationId, role: membership.role })),
  };

  return {
    ok: true,
    actor,
    sessionId: stored.id,
    sessionStartedAt: stored.createdAt,
    twoFactor,
  };
}

export type LogoutResult = { readonly ok: true; readonly revoked: number };

export async function logout(
  sessionId: string,
  actorId: string,
  deps: SessionDependencies,
): Promise<LogoutResult> {
  const now = deps.clock.now();
  await deps.sessions.revoke(sessionId, now);
  await deps.audit.record(
    {
      actorId,
      actorType: 'user',
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: sessionId,
    },
    now,
  );
  return { ok: true, revoked: 1 };
}

/**
 * Signs out everywhere.
 *
 * Also invoked on password change and on suspension — the operations where
 * leaving other sessions alive would defeat the point of the action.
 */
export async function logoutAllSessions(
  userId: string,
  deps: SessionDependencies,
  options: { exceptSessionId?: string; reason?: string } = {},
): Promise<LogoutResult> {
  const now = deps.clock.now();
  const revoked = await deps.sessions.revokeAllForUser(userId, now, options.exceptSessionId);

  await deps.audit.record(
    {
      actorId: userId,
      actorType: 'user',
      action: 'auth.logout_all',
      resourceType: 'user',
      resourceId: userId,
      metadata: { revoked, reason: options.reason ?? 'user_request' },
    },
    now,
  );

  return { ok: true, revoked };
}

export interface ActiveDevice {
  readonly sessionId: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly isCurrent: boolean;
}

/**
 * The "my devices" list.
 *
 * Carries no IP addresses and no token material — only what a person needs to
 * recognise their own devices and spot one they do not.
 */
export async function listActiveDevices(
  userId: string,
  currentSessionId: string,
  deps: SessionDependencies,
): Promise<readonly ActiveDevice[]> {
  const sessions = await deps.sessions.listActiveForUser(userId, deps.clock.now());
  return sessions.map((session) => ({
    sessionId: session.id,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    isCurrent: session.id === currentSessionId,
  }));
}

export type SuspendResult =
  | { readonly ok: true; readonly sessionsRevoked: number }
  | { readonly ok: false; readonly error: DomainError };

/**
 * Suspends an account and ends every session it holds.
 *
 * ⚠️ **Open decision PD-02.** This deliberately does *not* touch the user's
 * published invitations: no ADR decides what should happen to them, and
 * inventing behaviour here could take down a wedding invitation two days before
 * the event. See docs/19-decisions-pending-approval.md §6.
 */
export async function suspendAccount(
  targetUserId: string,
  staffActorId: string,
  reason: string,
  deps: SessionDependencies,
): Promise<SuspendResult> {
  const now = deps.clock.now();
  const user = await deps.users.findById(targetUserId);
  if (!user) return { ok: false, error: domainError('UNAUTHENTICATED') };

  await deps.users.setStatus(targetUserId, 'suspended', reason, now);
  const sessionsRevoked = await deps.sessions.revokeAllForUser(targetUserId, now);

  await deps.audit.record(
    {
      actorId: staffActorId,
      actorType: 'staff',
      action: 'admin.user_suspended',
      resourceType: 'user',
      resourceId: targetUserId,
      metadata: { reason, sessionsRevoked },
    },
    now,
  );

  return { ok: true, sessionsRevoked };
}
