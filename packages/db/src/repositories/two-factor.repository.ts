import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type {
  NewTwoFactorCredential,
  TwoFactorCredentialRecord,
  TwoFactorRepository,
} from '@zfaf/core';

/**
 * Second-factor persistence (docs/09 §2.8).
 *
 * Two properties this adapter is responsible for, and both are enforced in the
 * `WHERE` clause rather than in TypeScript above it:
 *
 *   • **Replay protection is a compare-and-set.** `recordUsedStep` updates only
 *     when the new step is strictly greater than the stored one, so two
 *     requests carrying the same code cannot both succeed. A read-then-write
 *     lets both through, and two requests carrying the same code is precisely
 *     the situation replay protection exists for.
 *   • **A recovery code is consumed once.** `consumeRecoveryCode` matches on
 *     `usedAt: null`; the row it fails to match is a code already spent.
 *
 * The secret itself arrives already encrypted — this layer never sees
 * plaintext and holds no key.
 */
export class PrismaTwoFactorRepository implements TwoFactorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByUserId(userId: string): Promise<TwoFactorCredentialRecord | null> {
    const row = await this.prisma.twoFactorCredential.findUnique({ where: { userId } });
    return row
      ? {
          id: row.id,
          userId: row.userId,
          secretSealed: Uint8Array.from(row.secretSealed),
          confirmedAt: row.confirmedAt,
          lastUsedStep: row.lastUsedStep,
          createdAt: row.createdAt,
        }
      : null;
  }

  /**
   * Starts or restarts enrollment.
   *
   * The update branch deliberately resets `confirmedAt` and `lastUsedStep` to
   * null: this path is only reachable when no confirmed credential exists (the
   * use case checks first), and leaving a stale step behind would reject the
   * first code from the *new* authenticator.
   */
  async upsertUnconfirmed(credential: NewTwoFactorCredential): Promise<TwoFactorCredentialRecord> {
    const sealed = Buffer.from(credential.secretSealed);
    const row = await this.prisma.twoFactorCredential.upsert({
      where: { userId: credential.userId },
      create: {
        id: credential.id,
        userId: credential.userId,
        secretSealed: sealed,
        createdAt: credential.now,
        updatedAt: credential.now,
      },
      update: {
        secretSealed: sealed,
        confirmedAt: null,
        lastUsedStep: null,
        updatedAt: credential.now,
      },
    });

    return {
      id: row.id,
      userId: row.userId,
      secretSealed: Uint8Array.from(row.secretSealed),
      confirmedAt: row.confirmedAt,
      lastUsedStep: row.lastUsedStep,
      createdAt: row.createdAt,
    };
  }

  async confirm(credentialId: string, step: bigint, at: Date): Promise<boolean> {
    // `confirmedAt: null` in the predicate: two simultaneous confirmations must
    // not both mint a set of recovery codes.
    const result = await this.prisma.twoFactorCredential.updateMany({
      where: { id: credentialId, confirmedAt: null },
      data: { confirmedAt: at, lastUsedStep: step, updatedAt: at },
    });
    return result.count === 1;
  }

  async recordUsedStep(credentialId: string, step: bigint): Promise<boolean> {
    const result = await this.prisma.twoFactorCredential.updateMany({
      where: {
        id: credentialId,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step },
    });
    return result.count === 1;
  }

  async deleteForUser(userId: string): Promise<boolean> {
    const [credentials] = await this.prisma.$transaction([
      this.prisma.twoFactorCredential.deleteMany({ where: { userId } }),
      this.prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    ]);
    return credentials.count > 0;
  }

  /**
   * Issues a fresh set, discarding whatever came before.
   *
   * One transaction, because a user holding an empty recovery-code set — even
   * for the milliseconds between a delete and an insert — is a user who cannot
   * get back in if their phone dies in that window.
   */
  async replaceRecoveryCodes(
    userId: string,
    codeHashes: readonly Uint8Array[],
    at: Date,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.twoFactorRecoveryCode.createMany({
        data: codeHashes.map((hash) => ({
          id: randomUUID(),
          userId,
          codeHash: Buffer.from(hash),
          createdAt: at,
        })),
      }),
    ]);
  }

  async consumeRecoveryCode(userId: string, codeHash: Uint8Array, at: Date): Promise<boolean> {
    const result = await this.prisma.twoFactorRecoveryCode.updateMany({
      // `userId` as well as the hash: the hash is globally unique, but matching
      // on it alone would let one account's code satisfy another's challenge if
      // that uniqueness were ever relaxed.
      where: { userId, codeHash: Buffer.from(codeHash), usedAt: null },
      data: { usedAt: at },
    });
    return result.count === 1;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return await this.prisma.twoFactorRecoveryCode.count({
      where: { userId, usedAt: null },
    });
  }
}
