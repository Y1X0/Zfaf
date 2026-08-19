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
  PrismaTemplateCatalog,
  PrismaTwoFactorRepository,
  PrismaUserRepository,
  PrismaVerificationTokenRepository,
  getPrismaClient,
} from '@zfaf/db';
// Imported by subpath, not from the package root. The root barrel also
// exports the Argon2 adapter, whose native binding cannot be bundled — and a
// route that signs upload URLs has no use for a password hasher anyway.
import { S3StorageProvider } from '@zfaf/infra/storage';
import { NodeIdGenerator, NodeTokenGenerator } from '@zfaf/infra/crypto/tokens';
import { AesGcmSecretCipher } from '@zfaf/infra/crypto/cipher';
import { JsonLogger, LoggingErrorTracker, SentryErrorTracker } from '@zfaf/infra/observability';
import { NoopMailService, ResendMailService } from '@zfaf/infra/mail';
import { SlidingWindowRateLimiter } from '@zfaf/infra/rate-limit';
import { RedisAnalyticsBuffer, RedisDailySalt, getRedis } from '@zfaf/infra/analytics';
import { CloudflareCdnPurger } from '@zfaf/infra/cdn';
import {
  type AnalyticsBuffer,
  type CdnPurger,
  type DailySaltStore,
  type ErrorTracker,
  type Logger,
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
  readonly verificationTokens: PrismaVerificationTokenRepository;
  readonly audit: PrismaAuditLogRepository;
  readonly invitations: PrismaInvitationRepository;
  readonly rsvps: PrismaRsvpRepository;
  readonly analytics: PrismaAnalyticsRepository;
  readonly admin: PrismaAdminRepository;
  readonly media: PrismaMediaRepository;
  /** The published template library (docs/23 §7). */
  readonly templates: PrismaTemplateCatalog;
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
  /** Structured logging with a redaction pass that cannot be bypassed (docs/15 §2). */
  readonly logger: Logger;
  /** Where an unexpected failure goes (docs/15 §3). Never throws at its caller. */
  readonly errors: ErrorTracker;
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

  // `debug` is disabled outside development, per docs/15 §2.
  const logger = new JsonLogger({
    level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    service: 'web',
    env: env.NODE_ENV,
  });

  cached = {
    prisma,
    users: new PrismaUserRepository(prisma),
    sessions: new PrismaSessionRepository(prisma),
    memberships: new PrismaMembershipRepository(prisma),
    twoFactor: new PrismaTwoFactorRepository(prisma),
    verificationTokens: new PrismaVerificationTokenRepository(prisma),
    audit: new PrismaAuditLogRepository(prisma),
    invitations: new PrismaInvitationRepository(prisma),
    rsvps: new PrismaRsvpRepository(prisma),
    analytics: new PrismaAnalyticsRepository(prisma),
    admin: new PrismaAdminRepository(prisma),
    media: new PrismaMediaRepository(prisma),
    templates: new PrismaTemplateCatalog(prisma, (key, errors) => {
      // A template that will not parse is invisible to customers rather than
      // fatal, and that silence is exactly why it is logged loudly here.
      logger.error('template.manifest_invalid', { key, errors: JSON.stringify(errors) });
    }),
    salt: new RedisDailySalt(redis),
    analyticsBuffer: new RedisAnalyticsBuffer(redis),
    cdn: buildCdnPurger(env.CDN_ZONE_ID, env.CDN_API_TOKEN, env.PUBLIC_BASE_URL),
    storage: new S3StorageProvider({
      driver: env.STORAGE_DRIVER,
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET_MEDIA,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      // MinIO and Backblaze B2 address buckets by path; R2 and S3 by virtual host.
      forcePathStyle: env.STORAGE_DRIVER === 'minio' || env.STORAGE_DRIVER === 'b2',
    }),
    tokens: new NodeTokenGenerator(),
    cipher: new AesGcmSecretCipher(env.TOTP_ENCRYPTION_KEY),
    ids: new NodeIdGenerator(),
    rateLimiter: new SlidingWindowRateLimiter(),
    clock: systemClock,
    logger,
    errors: buildErrorTracker(env.SENTRY_DSN, env.NODE_ENV, logger),
    mail: buildMailService(env, logger),
    humanCheck: new TurnstileHumanCheck(),
    notifyRsvp: notifyRsvp,
  };

  return cached;
}

/**
 * The configured mail driver (Go-Live gate 2).
 *
 * `noop` drops the message rather than pretending to have sent it, which is
 * the honest behaviour for development — and which `packages/config` now
 * refuses to allow in production, because silence there means a customer
 * waiting at an inbox for a link nobody sent.
 *
 * **`smtp` has no adapter**, and has not had one since Phase 0. It falls back
 * to the no-op transport with an error in the log rather than throwing, and
 * that choice is deliberate in both directions:
 *
 *   • Throwing here would take down the *whole application*. This function
 *     runs once inside the composition root that every route imports, so a
 *     mail misconfiguration would stop the public invitation page from
 *     rendering — a page that sends no mail at all.
 *   • Falling back silently is what the code did before this change, and it is
 *     how a driver named after a working transport ends up sending nothing for
 *     a month. Hence the log line, and hence `parseEnv` refusing `smtp` in
 *     production outright.
 */
function buildMailService(env: ReturnType<typeof getEnv>, logger: Logger): MailService {
  switch (env.MAIL_DRIVER) {
    case 'resend':
      return new ResendMailService({
        // Validated by the config layer: `resend` without a key does not boot.
        apiKey: env.MAIL_RESEND_API_KEY as string,
        from: `${env.MAIL_FROM_NAME} <${env.MAIL_FROM_ADDRESS}>`,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        // Absent in production, where the adapter's own default is the
        // provider's API. Set by the e2e harness so the suite exercises this
        // adapter against a sink it controls.
        endpoint: env.MAIL_RESEND_ENDPOINT,
        logger,
      });
    case 'smtp':
      logger.error('mail.driver_unimplemented', {
        driver: 'smtp',
        // Said plainly, because the consequence is invisible otherwise.
        effect: 'no mail will be sent; falling back to the no-op transport',
      });
      return new NoopMailService();
    default:
      return new NoopMailService();
  }
}

/**
 * Sentry when a DSN is configured, and the log otherwise (docs/15 §3).
 *
 * The fallback writes through the logger rather than discarding, so a
 * deployment without Sentry still has its errors somewhere. A silent no-op
 * would make "no errors in Sentry" indistinguishable from "no Sentry".
 */
function buildErrorTracker(
  dsn: string | undefined,
  environment: string,
  logger: Logger,
): ErrorTracker {
  if (!dsn) return new LoggingErrorTracker(logger);
  return new SentryErrorTracker({ dsn, environment, logger });
}

/**
 * The purger, or an honest admission that there is none (D8.5).
 *
 * When the zone is unconfigured this returns `NO_CDN_PURGER`, which reports
 * `purged: false`. That distinction reaches the audit log, so a later incident
 * review can tell "we purged the edge" from "there was no edge to purge" —
 * which a stub that always claimed success would have erased.
 */
function buildCdnPurger(
  zoneId: string | undefined,
  apiToken: string | undefined,
  publicBaseUrl: string,
): CdnPurger {
  if (!zoneId || !apiToken) return NO_CDN_PURGER;
  return new CloudflareCdnPurger({ zoneId, apiToken, publicBaseUrl });
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
