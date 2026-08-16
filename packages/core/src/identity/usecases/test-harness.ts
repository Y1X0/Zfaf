import { type Clock, fixedClock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { MembershipRole, UserRole, UserStatus } from '../../authz/actor.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import type { RateLimiter, RateLimitVerdict } from '../ports/rate-limiter.js';
import type { TokenGenerator } from '../ports/token-generator.js';
import type { MailMessage, MailService } from '../ports/mail-service.js';
import type {
  AuditEntry,
  AuditLogRepository,
  MembershipRecord,
  MembershipRepository,
  NewSession,
  NewUser,
  NewVerificationToken,
  SessionRepository,
  StoredSession,
  StoredVerificationToken,
  UserRecord,
  UserRepository,
  VerificationPurpose,
  VerificationTokenRepository,
} from '../ports/identity-repositories.js';
import type {
  NewTwoFactorCredential,
  SecretCipher,
  TwoFactorCredentialRecord,
  TwoFactorRepository,
} from '../ports/two-factor-repository.js';
import type { AuthDependencies } from './authenticate.js';
import type { TwoFactorDependencies } from './two-factor.js';

/**
 * In-memory implementations of every identity port.
 *
 * Their purpose is to let authentication logic be tested exhaustively without a
 * database — which is the practical proof that `packages/core` really is
 * framework- and infrastructure-free (ADR-0002). The same use cases run against
 * Prisma in the integration suite, so both paths are exercised.
 *
 * The hasher counts its calls: several tests assert that an unknown address
 * costs the same work as a known one, which is what defeats timing-based
 * account enumeration.
 */

export interface CountingHasher extends PasswordHasher {
  hashCalls: number;
  verifyCalls: number;
}

export interface TestTwoFactorHarness extends TestAuthHarness {
  readonly twoFactorDeps: TwoFactorDependencies;
  readonly twoFactorRepo: InMemoryTwoFactorRepository;
}

export interface TestAuthHarness {
  readonly deps: AuthDependencies;
  readonly clock: Clock & { advance(ms: number): void };
  readonly hasher: CountingHasher;
  readonly mail: CapturingMail;
  readonly users: Map<string, UserRecord>;
  readonly sessions: Map<
    string,
    NewSession & { revokedAt: Date | null; twoFactorVerifiedAt: Date | null }
  >;
  readonly verificationTokens: Map<string, StoredVerificationToken>;
  readonly auditEntries: AuditEntry[];
  readonly memberships: InMemoryMembershipRepository;
}

class CapturingMail implements MailService {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastTo(recipient: string): MailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === recipient);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * A deliberately fast stand-in for argon2id.
 *
 * Real argon2id takes ~50ms by design, which would make this suite unusably
 * slow. The format is kept so that assertions about "not stored in recoverable
 * form" remain meaningful; the real hasher has its own tests.
 */
function makeHasher(): CountingHasher {
  return {
    algorithm: 'argon2id',
    hashCalls: 0,
    verifyCalls: 0,
    async hash(plaintext: string) {
      this.hashCalls += 1;
      let digest = 0;
      for (const char of plaintext) digest = (digest * 31 + char.charCodeAt(0)) | 0;
      return `$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$${(digest >>> 0).toString(16)}`;
    },
    async verify(storedHash: string, plaintext: string) {
      this.verifyCalls += 1;
      const expected = await this.hash(plaintext);
      this.hashCalls -= 1; // the inner hash is an implementation detail
      return expected === storedHash;
    },
    needsRehash: () => false,
  };
}

function makeTokenGenerator(): TokenGenerator {
  let counter = 0;
  return {
    generate(bytes: number): string {
      counter += 1;
      return `tok-${counter}-${'x'.repeat(Math.max(0, bytes - 8))}`;
    },
    randomBytes(count: number): Uint8Array {
      // Deterministic, so a test can assert on the derived secret rather than
      // on "some bytes appeared". Distinct per call, so two enrollments differ.
      counter += 1;
      const seed = counter;
      return Uint8Array.from({ length: count }, (_, index) => (seed * 137 + index * 31) & 0xff);
    },
    hash(token: string): Uint8Array {
      // A stable 32-byte digest, so tests can assert on hash length and on the
      // plaintext never appearing in storage.
      const out = new Uint8Array(32);
      for (let index = 0; index < token.length; index += 1) {
        const position = index % 32;
        out[position] = ((out[position] as number) * 31 + token.charCodeAt(index)) & 0xff;
      }
      return out;
    },
    verify(token: string, storedHash: Uint8Array): boolean {
      const candidate = this.hash(token);
      return candidate.every((byte, index) => byte === storedHash[index]);
    },
  };
}

class InMemoryUserRepository implements UserRepository {
  constructor(private readonly users: Map<string, UserRecord>) {}

  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.toLowerCase();
    return [...this.users.values()].find((user) => user.email === normalized) ?? null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const record: UserRecord = {
      id: user.id,
      email: user.email,
      emailVerifiedAt: null,
      passwordHash: user.passwordHash,
      name: user.name,
      locale: user.locale,
      marketCode: user.marketCode,
      role: 'customer' as UserRole,
      status: 'active' as UserStatus,
      failedLoginCount: 0,
      lockedUntil: null,
      deletionRequestedAt: null,
      createdAt: user.now,
    };
    this.users.set(record.id, record);
    return record;
  }

  private patch(userId: string, changes: Partial<UserRecord>): void {
    const existing = this.users.get(userId);
    if (existing) this.users.set(userId, { ...existing, ...changes });
  }

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    this.patch(userId, { emailVerifiedAt: at });
  }
  async updatePasswordHash(userId: string, hash: string): Promise<void> {
    this.patch(userId, { passwordHash: hash, failedLoginCount: 0, lockedUntil: null });
  }
  async recordFailedLogin(userId: string, lockedUntil: Date | null): Promise<void> {
    const existing = this.users.get(userId);
    if (existing) {
      this.patch(userId, { failedLoginCount: existing.failedLoginCount + 1, lockedUntil });
    }
  }
  async recordSuccessfulLogin(userId: string): Promise<void> {
    this.patch(userId, { failedLoginCount: 0, lockedUntil: null });
  }
  async setStatus(userId: string, status: UserStatus): Promise<void> {
    this.patch(userId, { status });
  }
  async requestDeletion(userId: string, at: Date): Promise<void> {
    this.patch(userId, { status: 'pending_deletion', deletionRequestedAt: at });
  }
  async cancelDeletion(userId: string): Promise<void> {
    this.patch(userId, { status: 'active', deletionRequestedAt: null });
  }
}

class InMemorySessionRepository implements SessionRepository {
  constructor(
    private readonly sessions: Map<
      string,
      NewSession & { revokedAt: Date | null; twoFactorVerifiedAt: Date | null }
    >,
  ) {}

  async create(session: NewSession): Promise<StoredSession> {
    this.sessions.set(session.id, { ...session, revokedAt: null, twoFactorVerifiedAt: null });
    return {
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
      revokedAt: null,
      createdAt: session.now,
      lastUsedAt: session.now,
      userAgent: session.userAgent,
      twoFactorVerifiedAt: null,
    };
  }

  async markTwoFactorVerified(sessionId: string, at: Date): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) this.sessions.set(sessionId, { ...existing, twoFactorVerifiedAt: at });
  }

  async findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null> {
    const match = [...this.sessions.values()].find(
      (session) =>
        session.tokenHash.length === tokenHash.length &&
        session.tokenHash.every((byte, index) => byte === tokenHash[index]),
    );
    return match
      ? {
          id: match.id,
          userId: match.userId,
          expiresAt: match.expiresAt,
          revokedAt: match.revokedAt,
          createdAt: match.now,
          lastUsedAt: match.now,
          userAgent: match.userAgent,
          twoFactorVerifiedAt: match.twoFactorVerifiedAt,
        }
      : null;
  }

  async touch(): Promise<void> {}

  async revoke(sessionId: string, at: Date): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) this.sessions.set(sessionId, { ...existing, revokedAt: at });
  }

  async revokeAllForUser(userId: string, at: Date, exceptSessionId?: string): Promise<number> {
    let revoked = 0;
    for (const [id, session] of this.sessions) {
      if (session.userId !== userId || id === exceptSessionId || session.revokedAt) continue;
      this.sessions.set(id, { ...session, revokedAt: at });
      revoked += 1;
    }
    return revoked;
  }

  async listActiveForUser(userId: string, now: Date): Promise<readonly StoredSession[]> {
    return [...this.sessions.values()]
      .filter(
        (session) => session.userId === userId && !session.revokedAt && session.expiresAt > now,
      )
      .map((session) => ({
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        createdAt: session.now,
        lastUsedAt: session.now,
        userAgent: session.userAgent,
        twoFactorVerifiedAt: session.twoFactorVerifiedAt,
      }));
  }

  async deleteExpired(): Promise<number> {
    return 0;
  }
}

class InMemoryVerificationTokenRepository implements VerificationTokenRepository {
  constructor(
    private readonly tokens: Map<string, StoredVerificationToken & { tokenHash: Uint8Array }>,
  ) {}

  async create(token: NewVerificationToken): Promise<void> {
    this.tokens.set(token.id, {
      id: token.id,
      userId: token.userId,
      purpose: token.purpose,
      email: token.email,
      expiresAt: token.expiresAt,
      usedAt: null,
      tokenHash: token.tokenHash,
    });
  }

  async findByTokenHash(
    purpose: VerificationPurpose,
    tokenHash: Uint8Array,
  ): Promise<StoredVerificationToken | null> {
    return (
      [...this.tokens.values()].find(
        (token) =>
          token.purpose === purpose &&
          token.tokenHash.length === tokenHash.length &&
          token.tokenHash.every((byte, index) => byte === tokenHash[index]),
      ) ?? null
    );
  }

  async consume(tokenId: string, at: Date): Promise<boolean> {
    const existing = this.tokens.get(tokenId);
    if (!existing || existing.usedAt !== null) return false;
    this.tokens.set(tokenId, { ...existing, usedAt: at });
    return true;
  }

  async invalidateAllForUser(
    userId: string,
    purpose: VerificationPurpose,
    at: Date,
  ): Promise<number> {
    let count = 0;
    for (const [id, token] of this.tokens) {
      if (token.userId !== userId || token.purpose !== purpose || token.usedAt) continue;
      this.tokens.set(id, { ...token, usedAt: at });
      count += 1;
    }
    return count;
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly records = new Map<string, MembershipRecord>();

  private key(invitationId: string, userId: string): string {
    return `${invitationId}:${userId}`;
  }

  async listForUser(userId: string): Promise<readonly MembershipRecord[]> {
    return [...this.records.values()].filter((record) => record.userId === userId);
  }

  async find(invitationId: string, userId: string): Promise<MembershipRecord | null> {
    return this.records.get(this.key(invitationId, userId)) ?? null;
  }

  async grant(
    invitationId: string,
    userId: string,
    role: MembershipRole,
    _invitedBy: string | null,
    at: Date,
  ): Promise<MembershipRecord> {
    const record: MembershipRecord = { invitationId, userId, role, acceptedAt: at };
    this.records.set(this.key(invitationId, userId), record);
    return record;
  }

  async revoke(invitationId: string, userId: string): Promise<boolean> {
    return this.records.delete(this.key(invitationId, userId));
  }
}

class RecordingAuditLog implements AuditLogRepository {
  constructor(private readonly entries: AuditEntry[]) {}
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** A sliding-window limiter, mirroring the production algorithm. */
class TestRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  async consume(
    key: string,
    limit: number,
    windowMs: number,
    now: Date,
  ): Promise<RateLimitVerdict> {
    const cutoff = now.getTime() - windowMs;
    const kept = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (kept.length >= limit) {
      return { allowed: false, remaining: 0, resetAt: new Date(now.getTime() + windowMs) };
    }
    kept.push(now.getTime());
    this.hits.set(key, kept);
    return {
      allowed: true,
      remaining: limit - kept.length,
      resetAt: new Date(now.getTime() + windowMs),
    };
  }

  async peek(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitVerdict> {
    const cutoff = now.getTime() - windowMs;
    const kept = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    return {
      allowed: kept.length < limit,
      remaining: Math.max(0, limit - kept.length),
      resetAt: new Date(now.getTime() + windowMs),
    };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }
}

export function buildTestAuthDependencies(start: Date): TestAuthHarness {
  const clock = fixedClock(start);
  const users = new Map<string, UserRecord>();
  const sessions = new Map<
    string,
    NewSession & { revokedAt: Date | null; twoFactorVerifiedAt: Date | null }
  >();
  const verificationTokens = new Map<string, StoredVerificationToken & { tokenHash: Uint8Array }>();
  const auditEntries: AuditEntry[] = [];

  const hasher = makeHasher();
  const mail = new CapturingMail();
  const memberships = new InMemoryMembershipRepository();

  let idCounter = 0;
  const ids: IdGenerator = {
    uuid: () => {
      idCounter += 1;
      return `018f3a2b-${String(idCounter).padStart(4, '0')}-7e8f-9a0b-1c2d3e4f5a6b`;
    },
    token: (bytes: number) => `id-token-${bytes}`,
  };

  const deps: AuthDependencies = {
    users: new InMemoryUserRepository(users),
    sessions: new InMemorySessionRepository(sessions),
    verificationTokens: new InMemoryVerificationTokenRepository(verificationTokens),
    audit: new RecordingAuditLog(auditEntries),
    hasher,
    tokens: makeTokenGenerator(),
    rateLimiter: new TestRateLimiter(),
    mail,
    clock,
    ids,
  };

  return {
    deps,
    clock,
    hasher,
    mail,
    users,
    sessions,
    verificationTokens,
    auditEntries,
    memberships,
  };
}

/**
 * A cipher that seals by prefixing rather than by encrypting.
 *
 * The point of a test double here is to keep the use-case tests about *policy*
 * — replay, throttling, mandatory roles — rather than about AES. The real
 * `AesGcmSecretCipher` is exercised against its own properties in
 * `packages/infra`, including the tamper case this double deliberately does
 * not simulate.
 */
export class PassthroughCipher implements SecretCipher {
  encrypt(plaintext: Uint8Array): Uint8Array {
    const sealed = new Uint8Array(plaintext.length + 1);
    sealed[0] = 0x5a;
    sealed.set(plaintext, 1);
    return sealed;
  }

  decrypt(sealed: Uint8Array): Uint8Array | null {
    if (sealed.length < 1 || sealed[0] !== 0x5a) return null;
    return sealed.slice(1);
  }
}

export class InMemoryTwoFactorRepository implements TwoFactorRepository {
  private credential: TwoFactorCredentialRecord | null = null;
  private codes: { userId: string; hash: Uint8Array; usedAt: Date | null }[] = [];

  async findByUserId(userId: string): Promise<TwoFactorCredentialRecord | null> {
    return this.credential?.userId === userId ? this.credential : null;
  }

  async upsertUnconfirmed(credential: NewTwoFactorCredential): Promise<TwoFactorCredentialRecord> {
    this.credential = {
      id: credential.id,
      userId: credential.userId,
      secretSealed: credential.secretSealed,
      confirmedAt: null,
      lastUsedStep: null,
      createdAt: credential.now,
    };
    return this.credential;
  }

  async confirm(credentialId: string, step: bigint, at: Date): Promise<boolean> {
    if (!this.credential || this.credential.id !== credentialId) return false;
    if (this.credential.confirmedAt) return false;
    this.credential = { ...this.credential, confirmedAt: at, lastUsedStep: step };
    return true;
  }

  async recordUsedStep(credentialId: string, step: bigint): Promise<boolean> {
    if (!this.credential || this.credential.id !== credentialId) return false;
    const previous = this.credential.lastUsedStep;
    if (previous !== null && step <= previous) return false;
    this.credential = { ...this.credential, lastUsedStep: step };
    return true;
  }

  async deleteForUser(userId: string): Promise<boolean> {
    const had = this.credential?.userId === userId;
    if (had) this.credential = null;
    this.codes = this.codes.filter((code) => code.userId !== userId);
    return had;
  }

  async replaceRecoveryCodes(
    userId: string,
    codeHashes: readonly Uint8Array[],
    _at: Date,
  ): Promise<void> {
    this.codes = this.codes.filter((code) => code.userId !== userId);
    for (const hash of codeHashes) this.codes.push({ userId, hash, usedAt: null });
  }

  async consumeRecoveryCode(userId: string, codeHash: Uint8Array, at: Date): Promise<boolean> {
    const match = this.codes.find(
      (code) =>
        code.userId === userId &&
        code.usedAt === null &&
        code.hash.length === codeHash.length &&
        code.hash.every((byte, index) => byte === codeHash[index]),
    );
    if (!match) return false;
    match.usedAt = at;
    return true;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.codes.filter((code) => code.userId === userId && code.usedAt === null).length;
  }
}

/** The auth harness plus everything the two-factor use cases need. */
export function buildTestTwoFactorDependencies(start: Date): TestTwoFactorHarness {
  const harness = buildTestAuthDependencies(start);
  const twoFactorRepo = new InMemoryTwoFactorRepository();

  return {
    ...harness,
    twoFactorRepo,
    twoFactorDeps: {
      users: harness.deps.users,
      sessions: harness.deps.sessions,
      twoFactor: twoFactorRepo,
      audit: harness.deps.audit,
      cipher: new PassthroughCipher(),
      tokens: harness.deps.tokens,
      rateLimiter: harness.deps.rateLimiter,
      clock: harness.clock,
      ids: harness.deps.ids,
    },
  };
}
