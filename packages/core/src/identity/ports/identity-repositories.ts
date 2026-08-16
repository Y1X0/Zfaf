import type { UserRole, UserStatus, MembershipRole } from '../../authz/actor.js';

/**
 * Identity persistence ports.
 *
 * Deliberately split by concept rather than collapsed into one `UserRepository`:
 * *who someone is*, *how they prove it*, *what they belong to* and *how a
 * session stays valid* are four different things with four different lifetimes.
 */

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly passwordHash: string | null;
  readonly name: string | null;
  readonly locale: string;
  readonly marketCode: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly deletionRequestedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewUser {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly name: string | null;
  readonly locale: string;
  readonly marketCode: string;
  readonly now: Date;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  /** Case-insensitive by way of citext, so casing cannot fork an account. */
  findByEmail(email: string): Promise<UserRecord | null>;
  create(user: NewUser): Promise<UserRecord>;

  markEmailVerified(userId: string, at: Date): Promise<void>;
  updatePasswordHash(userId: string, hash: string, at: Date): Promise<void>;

  recordFailedLogin(userId: string, lockedUntil: Date | null, at: Date): Promise<void>;
  recordSuccessfulLogin(userId: string, at: Date): Promise<void>;

  setStatus(userId: string, status: UserStatus, reason: string | null, at: Date): Promise<void>;
  requestDeletion(userId: string, at: Date): Promise<void>;
  cancelDeletion(userId: string, at: Date): Promise<void>;
}

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date;
  readonly ipHash: Uint8Array | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

export interface StoredSession {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly userAgent: string | null;
}

export interface SessionRepository {
  create(session: NewSession): Promise<StoredSession>;
  /** Lookup is by hash: the plaintext token never reaches the database. */
  findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null>;
  touch(sessionId: string, lastUsedAt: Date, newExpiresAt: Date | null): Promise<void>;
  revoke(sessionId: string, at: Date): Promise<void>;
  /** Sign out everywhere. Also runs on password change and on suspension. */
  revokeAllForUser(userId: string, at: Date, exceptSessionId?: string): Promise<number>;
  listActiveForUser(userId: string, now: Date): Promise<readonly StoredSession[]>;
  deleteExpired(before: Date): Promise<number>;
}

export type VerificationPurpose = 'email_verification' | 'password_reset';

export interface NewVerificationToken {
  readonly id: string;
  readonly userId: string;
  readonly purpose: VerificationPurpose;
  readonly tokenHash: Uint8Array;
  readonly email: string | null;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface StoredVerificationToken {
  readonly id: string;
  readonly userId: string;
  readonly purpose: VerificationPurpose;
  readonly email: string | null;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface VerificationTokenRepository {
  create(token: NewVerificationToken): Promise<void>;
  findByTokenHash(
    purpose: VerificationPurpose,
    tokenHash: Uint8Array,
  ): Promise<StoredVerificationToken | null>;
  /**
   * Marks a token used, returning false when it was already consumed.
   * Single-use is enforced by the update's own predicate rather than by a
   * read-then-write, so two simultaneous redemptions cannot both succeed.
   */
  consume(tokenId: string, at: Date): Promise<boolean>;
  invalidateAllForUser(userId: string, purpose: VerificationPurpose, at: Date): Promise<number>;
}

export interface MembershipRecord {
  readonly invitationId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly acceptedAt: Date | null;
}

export interface MembershipRepository {
  /** The authoritative membership list. This is what a claimed tenant id is checked against. */
  listForUser(userId: string): Promise<readonly MembershipRecord[]>;
  find(invitationId: string, userId: string): Promise<MembershipRecord | null>;
  grant(
    invitationId: string,
    userId: string,
    role: MembershipRole,
    invitedBy: string | null,
    at: Date,
  ): Promise<MembershipRecord>;
  revoke(invitationId: string, userId: string): Promise<boolean>;
}

export interface AuditEntry {
  readonly actorId: string | null;
  readonly actorType: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** Redacted before it gets here: no tokens, no passwords, no guest data. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly ipHash?: Uint8Array | null;
  readonly requestId?: string | null;
}

export interface AuditLogRepository {
  record(entry: AuditEntry, at: Date): Promise<void>;
}
