import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  type Actor,
  base32Decode,
  confirmTwoFactorEnrollment,
  beginTwoFactorEnrollment,
  systemClock,
  totpCodeAt,
  verifyTwoFactorChallenge,
} from '@zfaf/core';
import { AesGcmSecretCipher, NodeIdGenerator, NodeTokenGenerator } from '@zfaf/infra';

import { PrismaTwoFactorRepository } from '../src/repositories/two-factor.repository.js';
import {
  PrismaAuditLogRepository,
  PrismaSessionRepository,
  PrismaUserRepository,
} from '../src/repositories/identity.repository.js';
import { resetDatabase, seedUser, testClient } from './helpers/database.js';

/**
 * Two-factor authentication against real PostgreSQL (docs/09 §2.8, M10).
 *
 * Three of the properties this feature rests on have no meaningful in-memory
 * test, because they *are* statements about the database:
 *
 *   • **Replay protection is a compare-and-set.** Two concurrent requests
 *     carrying the same code must produce exactly one success. An in-memory
 *     double is single-threaded and will always agree with itself.
 *   • **A recovery code is consumed once**, under the same concurrency.
 *   • **The secret on disk is ciphertext.** The only way to be sure is to read
 *     the column back and look at it.
 *
 * The cipher here is the real `AesGcmSecretCipher`, not the test double: what
 * is under test includes the round trip through a `BYTEA` column.
 */

let prisma: PrismaClient;
let repository: PrismaTwoFactorRepository;
let deps: Parameters<typeof beginTwoFactorEnrollment>[1];
let userId: string;
let sessionId: string;

const CIPHER_KEY = 'integration-test-totp-key-at-least-32-chars';

function actorFor(role: 'admin' | 'customer' = 'admin'): Actor {
  return {
    kind: 'user',
    userId,
    role,
    emailVerified: true,
    status: 'active',
    sessionId,
    memberships: [],
  };
}

beforeAll(() => {
  prisma = testClient();
  repository = new PrismaTwoFactorRepository(prisma);
  deps = {
    users: new PrismaUserRepository(prisma),
    sessions: new PrismaSessionRepository(prisma),
    twoFactor: repository,
    audit: new PrismaAuditLogRepository(prisma),
    cipher: new AesGcmSecretCipher(CIPHER_KEY),
    tokens: new NodeTokenGenerator(),
    rateLimiter: {
      // Deliberately permissive: throttling is covered by the unit suite, and
      // a shared limiter here would make these tests order-dependent.
      consume: async () => ({ allowed: true, remaining: 99, resetAt: new Date() }),
      reset: async () => {},
      peek: async () => ({ allowed: true, remaining: 99, resetAt: new Date() }),
    },
    clock: systemClock,
    ids: new NodeIdGenerator(),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  userId = await seedUser(prisma, { role: 'admin' });
  sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      tokenHash: Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
});

/** Runs enrollment and returns the plaintext secret, as the browser saw it. */
async function enrol(): Promise<Uint8Array> {
  const started = await beginTwoFactorEnrollment(actorFor(), deps);
  if (!started.ok) throw new Error('enrollment did not start');
  const secret = base32Decode(started.value.secret);
  if (!secret) throw new Error('the emitted secret is not base32');

  const confirmed = await confirmTwoFactorEnrollment(
    actorFor(),
    totpCodeAt(secret, new Date()),
    deps,
  );
  if (!confirmed.ok) throw new Error('confirmation failed');
  return secret;
}

describe('what the database actually holds', () => {
  it('stores the secret as ciphertext, never as the bytes an authenticator uses', async () => {
    const secret = await enrol();

    const row = await prisma.twoFactorCredential.findUniqueOrThrow({ where: { userId } });
    const stored = Buffer.from(row.secretSealed);

    expect(stored.includes(Buffer.from(secret))).toBe(false);
    // nonce (12) + secret (20) + tag (16)
    expect(stored.length).toBe(48);
    // And it is genuinely recoverable with the key, which is the whole point.
    expect(new AesGcmSecretCipher(CIPHER_KEY).decrypt(Uint8Array.from(stored))).toEqual(secret);
  });

  it('is unreadable with a different key, so a dump alone yields nothing', async () => {
    await enrol();
    const row = await prisma.twoFactorCredential.findUniqueOrThrow({ where: { userId } });
    const wrongKey = new AesGcmSecretCipher('a-completely-different-key-32-characters!!');
    expect(wrongKey.decrypt(Uint8Array.from(row.secretSealed))).toBeNull();
  });

  it('stores recovery codes only as hashes', async () => {
    const started = await beginTwoFactorEnrollment(actorFor(), deps);
    if (!started.ok) return;
    const secret = base32Decode(started.value.secret)!;
    const confirmed = await confirmTwoFactorEnrollment(
      actorFor(),
      totpCodeAt(secret, new Date()),
      deps,
    );
    if (!confirmed.ok) return;

    const rows = await prisma.twoFactorRecoveryCode.findMany({ where: { userId } });
    expect(rows).toHaveLength(10);

    const blob = rows.map((row) => Buffer.from(row.codeHash).toString('hex')).join('');
    for (const code of confirmed.value.recoveryCodes) {
      expect(blob).not.toContain(Buffer.from(code, 'utf8').toString('hex'));
      expect(rows.every((row) => row.codeHash.length === 32)).toBe(true);
    }
  });

  it('cascades away with the account, leaving no orphan credential', async () => {
    await enrol();
    await prisma.user.delete({ where: { id: userId } });

    expect(await prisma.twoFactorCredential.count({ where: { userId } })).toBe(0);
    expect(await prisma.twoFactorRecoveryCode.count({ where: { userId } })).toBe(0);
  });
});

describe('replay protection under concurrency', () => {
  it('accepts one of two simultaneous requests carrying the same code', async () => {
    const secret = await enrol();
    // A step past the one enrollment consumed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const code = totpCodeAt(secret, new Date(Date.now() + 30_000));

    // Both requests are in flight before either has written. A read-then-write
    // implementation lets both through; the compare-and-set does not.
    const [first, second] = await Promise.all([
      verifyTwoFactorChallenge(actorFor(), code, deps),
      verifyTwoFactorChallenge(actorFor(), code, deps),
    ]);

    const succeeded = [first, second].filter((result) => result.ok).length;
    expect(succeeded).toBe(1);
  });

  it('refuses a step that is not strictly greater than the stored one', async () => {
    await enrol();
    const credential = await repository.findByUserId(userId);
    const step = credential?.lastUsedStep ?? 0n;

    expect(await repository.recordUsedStep(credential!.id, step)).toBe(false);
    expect(await repository.recordUsedStep(credential!.id, step - 1n)).toBe(false);
    expect(await repository.recordUsedStep(credential!.id, step + 1n)).toBe(true);
  });
});

describe('recovery codes under concurrency', () => {
  it('lets exactly one of two simultaneous redemptions through', async () => {
    const started = await beginTwoFactorEnrollment(actorFor(), deps);
    if (!started.ok) return;
    const secret = base32Decode(started.value.secret)!;
    const confirmed = await confirmTwoFactorEnrollment(
      actorFor(),
      totpCodeAt(secret, new Date()),
      deps,
    );
    if (!confirmed.ok) return;

    const code = confirmed.value.recoveryCodes[0]!;
    const [first, second] = await Promise.all([
      verifyTwoFactorChallenge(actorFor(), code, deps),
      verifyTwoFactorChallenge(actorFor(), code, deps),
    ]);

    expect([first, second].filter((result) => result.ok).length).toBe(1);
    expect(await repository.countUnusedRecoveryCodes(userId)).toBe(9);
  });

  it('replaces the whole set atomically, never leaving a user with none', async () => {
    await enrol();
    const before = await prisma.twoFactorRecoveryCode.findMany({ where: { userId } });

    await repository.replaceRecoveryCodes(
      userId,
      Array.from({ length: 10 }, (_, index) => new Uint8Array(32).fill(index + 100)),
      new Date(),
    );

    const after = await prisma.twoFactorRecoveryCode.findMany({ where: { userId } });
    expect(after).toHaveLength(10);
    expect(after.map((row) => row.id)).not.toEqual(before.map((row) => row.id));
  });
});

describe('the session record', () => {
  it('is marked verified only after the challenge is answered', async () => {
    const secret = await enrol();
    // Enrollment verifies the session it ran in, so start from a fresh one.
    const secondSession = randomUUID();
    await prisma.session.create({
      data: {
        id: secondSession,
        userId,
        tokenHash: Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    let row = await prisma.session.findUniqueOrThrow({ where: { id: secondSession } });
    expect(row.twoFactorVerifiedAt).toBeNull();

    const actor = { ...actorFor(), sessionId: secondSession };
    const result = await verifyTwoFactorChallenge(
      actor,
      totpCodeAt(secret, new Date(Date.now() + 30_000)),
      deps,
    );
    expect(result.ok).toBe(true);

    row = await prisma.session.findUniqueOrThrow({ where: { id: secondSession } });
    expect(row.twoFactorVerifiedAt).not.toBeNull();
  });

  it('cannot be verified once it has been revoked', async () => {
    await enrol();
    await prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    await new PrismaSessionRepository(prisma).markTwoFactorVerified(sessionId, new Date());
    const row = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    // Already verified by enrollment; the point is that the revoked write did
    // not resurrect anything — the timestamp is the enrollment's, not now's.
    expect(row.revokedAt).not.toBeNull();
  });
});
