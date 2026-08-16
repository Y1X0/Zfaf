import { getEnv } from '@zfaf/config';
import {
  PrismaAuditLogRepository,
  PrismaInvitationRepository,
  PrismaMediaRepository,
  PrismaMembershipRepository,
  PrismaSessionRepository,
  PrismaUserRepository,
  getPrismaClient,
} from '@zfaf/db';
// Imported by subpath, not from the package root. The root barrel also
// exports the Argon2 adapter, whose native binding cannot be bundled — and a
// route that signs upload URLs has no use for a password hasher anyway.
import { S3StorageProvider } from '@zfaf/infra/storage';
import { NodeTokenGenerator } from '@zfaf/infra/crypto/tokens';
import { SlidingWindowRateLimiter } from '@zfaf/infra/rate-limit';
import { systemClock } from '@zfaf/core';

/**
 * Composition root for the web app.
 *
 * Adapters are constructed in exactly one place, so route handlers receive
 * ports and never reach for a client. It is also the only file that knows
 * which provider is configured — swapping storage or the rate limiter is a
 * change here and nowhere else (ADR-0001).
 *
 * Instances are module-level singletons because Next.js reuses the module
 * across requests in a single process; creating a Prisma client per request
 * exhausts the connection pool in minutes.
 */

let cached: Container | null = null;

export interface Container {
  readonly prisma: ReturnType<typeof getPrismaClient>;
  readonly users: PrismaUserRepository;
  readonly sessions: PrismaSessionRepository;
  readonly memberships: PrismaMembershipRepository;
  readonly audit: PrismaAuditLogRepository;
  readonly invitations: PrismaInvitationRepository;
  readonly media: PrismaMediaRepository;
  readonly storage: S3StorageProvider;
  readonly tokens: NodeTokenGenerator;
  readonly rateLimiter: SlidingWindowRateLimiter;
  readonly clock: typeof systemClock;
}

export function container(): Container {
  if (cached) return cached;

  const env = getEnv();
  const prisma = getPrismaClient();

  cached = {
    prisma,
    users: new PrismaUserRepository(prisma),
    sessions: new PrismaSessionRepository(prisma),
    memberships: new PrismaMembershipRepository(prisma),
    audit: new PrismaAuditLogRepository(prisma),
    invitations: new PrismaInvitationRepository(prisma),
    media: new PrismaMediaRepository(prisma),
    storage: new S3StorageProvider({
      driver: env.STORAGE_DRIVER,
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET_MEDIA,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      // MinIO addresses buckets by path; R2 and S3 by virtual host.
      forcePathStyle: env.STORAGE_DRIVER === 'minio',
    }),
    tokens: new NodeTokenGenerator(),
    rateLimiter: new SlidingWindowRateLimiter(),
    clock: systemClock,
  };

  return cached;
}
