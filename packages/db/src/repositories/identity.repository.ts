import type { PrismaClient } from '@prisma/client';
import type {
  AuditEntry,
  AuditLogRepository,
  MembershipRecord,
  MembershipRepository,
  MembershipRole,
  NewSession,
  NewUser,
  NewVerificationToken,
  SessionRepository,
  StoredSession,
  StoredVerificationToken,
  UserRecord,
  UserRepository,
  UserStatus,
  VerificationPurpose,
  VerificationTokenRepository,
} from '@zfaf/core';

/**
 * Identity persistence.
 *
 * Nothing recoverable is stored: passwords are argon2id hashes, and session,
 * verification and reset tokens are stored as SHA-256 digests (ADR-0006). A
 * read-only leak of this data yields no usable credential.
 */

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toUserRecord(row) : null;
  }

  /** Case-insensitive by way of citext, so casing cannot fork one account into two. */
  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row ? toUserRecord(row) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const row = await this.prisma.user.create({
      data: {
        id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        name: user.name,
        locale: user.locale,
        marketCode: user.marketCode,
        createdAt: user.now,
        updatedAt: user.now,
      },
    });
    return toUserRecord(row);
  }

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: at, updatedAt: at },
    });
  }

  async updatePasswordHash(userId: string, hash: string, at: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      // A password change also clears the lockout: the person demonstrably
      // controls the account.
      data: { passwordHash: hash, failedLoginCount: 0, lockedUntil: null, updatedAt: at },
    });
  }

  async recordFailedLogin(userId: string, lockedUntil: Date | null, at: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 }, lockedUntil, updatedAt: at },
    });
  }

  async recordSuccessfulLogin(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at, updatedAt: at },
    });
  }

  async setStatus(
    userId: string,
    status: UserStatus,
    reason: string | null,
    at: Date,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status,
        suspendedReason: status === 'suspended' ? reason : null,
        suspendedAt: status === 'suspended' ? at : null,
        updatedAt: at,
      },
    });
  }

  async requestDeletion(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: 'pending_deletion', deletionRequestedAt: at, updatedAt: at },
    });
  }

  /** Signing in cancels a scheduled deletion (docs/09 §8). */
  async cancelDeletion(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: 'active', deletionRequestedAt: null, updatedAt: at },
    });
  }
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(session: NewSession): Promise<StoredSession> {
    const row = await this.prisma.session.create({
      data: {
        id: session.id,
        userId: session.userId,
        tokenHash: Buffer.from(session.tokenHash),
        expiresAt: session.expiresAt,
        ipHash: session.ipHash ? Buffer.from(session.ipHash) : null,
        userAgent: session.userAgent,
        createdAt: session.now,
        lastUsedAt: session.now,
      },
    });
    return toStoredSession(row);
  }

  /** Lookup is by hash. The plaintext token never reaches the database. */
  async findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null> {
    const row = await this.prisma.session.findUnique({
      where: { tokenHash: Buffer.from(tokenHash) },
    });
    return row ? toStoredSession(row) : null;
  }

  async touch(sessionId: string, lastUsedAt: Date, newExpiresAt: Date | null): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { lastUsedAt, ...(newExpiresAt ? { expiresAt: newExpiresAt } : {}) },
    });
  }

  async revoke(sessionId: string, at: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  /**
   * Sign out everywhere.
   *
   * Also runs on password change and on suspension — the operations where
   * leaving other sessions alive would defeat the point of the action.
   */
  async revokeAllForUser(userId: string, at: Date, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: at },
    });
    return result.count;
  }

  async listActiveForUser(userId: string, now: Date): Promise<readonly StoredSession[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastUsedAt: 'desc' },
      take: 50,
    });
    return rows.map(toStoredSession);
  }

  async deleteExpired(before: Date): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return result.count;
  }
}

/**
 * Verification and reset tokens.
 *
 * Backed by two tables rather than one: an email-verification token and a
 * password-reset token have different lifetimes, different blast radii and
 * different retention, and keeping them apart means a bug in one cannot redeem
 * the other.
 */
export class PrismaVerificationTokenRepository implements VerificationTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(token: NewVerificationToken): Promise<void> {
    if (token.purpose === 'email_verification') {
      await this.prisma.emailVerification.create({
        data: {
          id: token.id,
          userId: token.userId,
          tokenHash: Buffer.from(token.tokenHash),
          email: token.email ?? '',
          expiresAt: token.expiresAt,
          createdAt: token.now,
        },
      });
      return;
    }

    await this.prisma.passwordReset.create({
      data: {
        id: token.id,
        userId: token.userId,
        tokenHash: Buffer.from(token.tokenHash),
        expiresAt: token.expiresAt,
        createdAt: token.now,
      },
    });
  }

  async findByTokenHash(
    purpose: VerificationPurpose,
    tokenHash: Uint8Array,
  ): Promise<StoredVerificationToken | null> {
    const hash = Buffer.from(tokenHash);

    if (purpose === 'email_verification') {
      const row = await this.prisma.emailVerification.findUnique({ where: { tokenHash: hash } });
      return row
        ? {
            id: row.id,
            userId: row.userId,
            purpose,
            email: row.email,
            expiresAt: row.expiresAt,
            usedAt: row.usedAt,
          }
        : null;
    }

    const row = await this.prisma.passwordReset.findUnique({ where: { tokenHash: hash } });
    return row
      ? {
          id: row.id,
          userId: row.userId,
          purpose,
          email: null,
          expiresAt: row.expiresAt,
          usedAt: row.usedAt,
        }
      : null;
  }

  /**
   * Marks a token used.
   *
   * Single-use is enforced by the `usedAt: null` predicate inside the update,
   * not by a read followed by a write: two simultaneous redemptions of one
   * reset link must not both succeed.
   */
  async consume(tokenId: string, at: Date): Promise<boolean> {
    const asVerification = await this.prisma.emailVerification.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: at },
    });
    if (asVerification.count > 0) return true;

    const asReset = await this.prisma.passwordReset.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: at },
    });
    return asReset.count > 0;
  }

  /** Issuing a new token invalidates the earlier ones, so only the latest mail is live. */
  async invalidateAllForUser(
    userId: string,
    purpose: VerificationPurpose,
    at: Date,
  ): Promise<number> {
    if (purpose === 'email_verification') {
      const result = await this.prisma.emailVerification.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: at },
      });
      return result.count;
    }

    const result = await this.prisma.passwordReset.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: at },
    });
    return result.count;
  }
}

/**
 * Membership.
 *
 * This repository is the authority a claimed tenant id is checked against
 * (`resolveTenantContext`). Nothing here ever trusts a client-supplied value.
 */
export class PrismaMembershipRepository implements MembershipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForUser(userId: string): Promise<readonly MembershipRecord[]> {
    const rows = await this.prisma.invitationMember.findMany({
      where: { userId, invitation: { deletedAt: null } },
      select: { invitationId: true, userId: true, role: true, acceptedAt: true },
    });
    return rows.map((row) => ({
      invitationId: row.invitationId,
      userId: row.userId,
      role: row.role as MembershipRole,
      acceptedAt: row.acceptedAt,
    }));
  }

  async find(invitationId: string, userId: string): Promise<MembershipRecord | null> {
    const row = await this.prisma.invitationMember.findUnique({
      where: { invitationId_userId: { invitationId, userId } },
      select: { invitationId: true, userId: true, role: true, acceptedAt: true },
    });
    return row
      ? {
          invitationId: row.invitationId,
          userId: row.userId,
          role: row.role as MembershipRole,
          acceptedAt: row.acceptedAt,
        }
      : null;
  }

  async grant(
    invitationId: string,
    userId: string,
    role: MembershipRole,
    invitedBy: string | null,
    at: Date,
  ): Promise<MembershipRecord> {
    const row = await this.prisma.invitationMember.upsert({
      where: { invitationId_userId: { invitationId, userId } },
      update: { role },
      create: {
        id: crypto.randomUUID(),
        invitationId,
        userId,
        role,
        invitedById: invitedBy,
        acceptedAt: at,
        createdAt: at,
      },
      select: { invitationId: true, userId: true, role: true, acceptedAt: true },
    });
    return {
      invitationId: row.invitationId,
      userId: row.userId,
      role: row.role as MembershipRole,
      acceptedAt: row.acceptedAt,
    };
  }

  /**
   * Removes a membership.
   *
   * Access ends on the next request, because `resolveSession` reloads
   * memberships every time rather than trusting what a session was issued with.
   */
  async revoke(invitationId: string, userId: string): Promise<boolean> {
    const result = await this.prisma.invitationMember.deleteMany({
      where: { invitationId, userId },
    });
    return result.count > 0;
  }
}

export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Appends an audit entry.
   *
   * The table rejects UPDATE and DELETE by trigger (M1): an audit log an
   * operator can edit is not an audit log.
   */
  async record(entry: AuditEntry, at: Date): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        metadata: (entry.metadata ?? {}) as object,
        ipHash: entry.ipHash ? Buffer.from(entry.ipHash) : null,
        requestId: entry.requestId ?? null,
        createdAt: at,
      },
    });
  }
}

// ── mapping ─────────────────────────────────────────────────────────────────

type UserRow = Awaited<ReturnType<PrismaClient['user']['findUniqueOrThrow']>>;
type SessionRow = Awaited<ReturnType<PrismaClient['session']['findUniqueOrThrow']>>;

/**
 * Maps a row to the domain record.
 *
 * Explicit rather than a spread, so `passwordHash` and other sensitive columns
 * are carried deliberately and a new column cannot leak upward by accident.
 */
function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.emailVerifiedAt,
    passwordHash: row.passwordHash,
    name: row.name,
    locale: row.locale,
    marketCode: row.marketCode,
    role: row.role,
    status: row.status,
    failedLoginCount: row.failedLoginCount,
    lockedUntil: row.lockedUntil,
    deletionRequestedAt: row.deletionRequestedAt,
    createdAt: row.createdAt,
  };
}

/** Note the absence of `tokenHash` and `ipHash`: neither belongs above this layer. */
function toStoredSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    userAgent: row.userAgent,
  };
}
