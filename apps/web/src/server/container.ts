import { getEnv } from '@zfaf/config';
import {
  PrismaAdminRepository,
  PrismaAnalyticsRepository,
  PrismaAuditLogRepository,
  PrismaInvitationRepository,
  PrismaMediaRepository,
  PrismaMembershipRepository,
  PrismaRsvpRepository,
  PrismaSessionRepository,
  PrismaTwoFactorRepository,
  PrismaUserRepository,
  getPrismaClient,
} from '@zfaf/db';
// Imported by subpath, not from the package root. The root barrel also
// exports the Argon2 adapter, whose native binding cannot be bundled — and a
// route that signs upload URLs has no use for a password hasher anyway.
import { S3StorageProvider } from '@zfaf/infra/storage';
import { NodeIdGenerator, NodeTokenGenerator } from '@zfaf/infra/crypto/tokens';
import { AesGcmSecretCipher } from '@zfaf/infra/crypto/cipher';
import { NoopMailService } from '@zfaf/infra/mail';
import { SlidingWindowRateLimiter } from '@zfaf/infra/rate-limit';
import { RedisAnalyticsBuffer, RedisDailySalt, getRedis } from '@zfaf/infra/analytics';
import { CloudflareCdnPurger } from '@zfaf/infra/cdn';
import {
  type AnalyticsBuffer,
  type CdnPurger,
  type DailySaltStore,
  type MailService,
  NO_CDN_PURGER,
  type RsvpNotification,
  type SecretCipher,
  systemClock,
} from '@zfaf/core';

import { TurnstileHumanCheck } from './turnstile.js';

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
  readonly twoFactor: PrismaTwoFactorRepository;
  readonly audit: PrismaAuditLogRepository;
  readonly invitations: PrismaInvitationRepository;
  readonly rsvps: PrismaRsvpRepository;
  readonly analytics: PrismaAnalyticsRepository;
  readonly admin: PrismaAdminRepository;
  readonly media: PrismaMediaRepository;
  /** The rotating salt (D8.1). Redis-only, never written anywhere durable. */
  readonly salt: DailySaltStore;
  readonly analyticsBuffer: AnalyticsBuffer;
  readonly cdn: CdnPurger;
  readonly storage: S3StorageProvider;
  readonly tokens: NodeTokenGenerator;
  /** Encrypts TOTP secrets at rest (docs/09 §2.8). Key from the secret manager. */
  readonly cipher: SecretCipher;
  readonly ids: NodeIdGenerator;
  readonly rateLimiter: SlidingWindowRateLimiter;
  readonly clock: typeof systemClock;
  readonly mail: MailService;
  readonly humanCheck: TurnstileHumanCheck;
  /** Tells an owner a guest replied (D7.7). Never allowed to fail a reply. */
  readonly notifyRsvp: (event: RsvpNotification) => Promise<void>;
}

export function container(): Container {
  if (cached) return cached;

  const env = getEnv();
  const prisma = getPrismaClient();
  const redis = getRedis(env.REDIS_URL);

  cached = {
    prisma,
    users: new PrismaUserRepository(prisma),
    sessions: new PrismaSessionRepository(prisma),
    memberships: new PrismaMembershipRepository(prisma),
    twoFactor: new PrismaTwoFactorRepository(prisma),
    audit: new PrismaAuditLogRepository(prisma),
    invitations: new PrismaInvitationRepository(prisma),
    rsvps: new PrismaRsvpRepository(prisma),
    analytics: new PrismaAnalyticsRepository(prisma),
    admin: new PrismaAdminRepository(prisma),
    media: new PrismaMediaRepository(prisma),
    salt: new RedisDailySalt(redis),
    analyticsBuffer: new RedisAnalyticsBuffer(redis),
    cdn: buildCdnPurger(env.CDN_ZONE_ID, env.CDN_API_TOKEN),
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
    cipher: new AesGcmSecretCipher(env.TOTP_ENCRYPTION_KEY),
    ids: new NodeIdGenerator(),
    rateLimiter: new SlidingWindowRateLimiter(),
    clock: systemClock,
    // The SMTP adapter arrives with the transactional-mail work; until then a
    // notification is dropped rather than pretended, and the `noop` driver is
    // the configured default outside production.
    mail: new NoopMailService(),
    humanCheck: new TurnstileHumanCheck(),
    notifyRsvp: notifyRsvp,
  };

  return cached;
}

/**
 * The purger, or an honest admission that there is none (D8.5).
 *
 * When the zone is unconfigured this returns `NO_CDN_PURGER`, which reports
 * `purged: false`. That distinction reaches the audit log, so a later incident
 * review can tell "we purged the edge" from "there was no edge to purge" —
 * which a stub that always claimed success would have erased.
 */
function buildCdnPurger(zoneId: string | undefined, apiToken: string | undefined): CdnPurger {
  if (!zoneId || !apiToken) return NO_CDN_PURGER;
  return new CloudflareCdnPurger({ zoneId, apiToken });
}

/**
 * Tells an invitation's owner that a guest replied (D7.7).
 *
 * Two deliberate omissions. It carries **no phone number and no note** — those
 * are the guest's details, and an inbox is not where they should accumulate —
 * and it never throws: the caller already treats a failure here as harmless,
 * but making that true at the source is cheaper than relying on it.
 */
async function notifyRsvp(event: RsvpNotification): Promise<void> {
  const deps = container();

  const invitation = await deps.prisma.invitation.findUnique({
    where: { id: event.invitationId },
    select: { title: true, locale: true, owner: { select: { email: true } } },
  });
  if (!invitation?.owner?.email) return;

  await deps.mail.send({
    to: invitation.owner.email,
    template: 'rsvp_received',
    locale: invitation.locale,
    data: {
      invitationTitle: invitation.title,
      guestName: event.guestName,
      attending: event.attending ? 'yes' : 'no',
      partySize: String(event.partySize),
    },
  });
}
