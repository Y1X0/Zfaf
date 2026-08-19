import { z } from 'zod';

/**
 * Environment validation.
 *
 * Parsed once at startup so a missing or malformed variable fails immediately
 * with a readable message, rather than surfacing as an obscure runtime error
 * during a user's first upload.
 */

const NonEmpty = z.string().trim().min(1);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PUBLIC_BASE_URL: z.string().url(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // 32 bytes is the floor for the session token HMAC/derivation material.
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  /**
   * The key that encrypts TOTP secrets at rest (docs/09 §2.8).
   *
   * Separate from `SESSION_SECRET` rather than derived from it, and that
   * separation is operational rather than aesthetic: rotating the session
   * secret is a routine, low-consequence act, while rotating this one makes
   * every enrolled authenticator stop working at once. Sharing the two would
   * mean the routine act silently performs the catastrophic one.
   *
   * Required, not optional. A second factor whose key is absent is a second
   * factor that quietly does not work, and this system refuses to boot on a
   * partial environment precisely so that cannot happen in production.
   */
  TOTP_ENCRYPTION_KEY: z.string().min(32, 'TOTP_ENCRYPTION_KEY must be at least 32 characters'),

  STORAGE_DRIVER: z.enum(['minio', 'r2', 's3', 'b2']).default('minio'),
  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: NonEmpty.default('auto'),
  STORAGE_BUCKET_MEDIA: NonEmpty,
  STORAGE_ACCESS_KEY_ID: NonEmpty,
  STORAGE_SECRET_ACCESS_KEY: NonEmpty,
  STORAGE_PUBLIC_BASE_URL: z.string().url(),

  /**
   * Where an uploaded photograph gets encoded (ADR-0023).
   *
   * `queue` is the default and the original design: `complete` puts a job in
   * BullMQ and `apps/worker` does the work, isolated from the request budget
   * (docs/08 §6).
   *
   * `inline` does it in the request that completed the upload, and exists for
   * one reason — no platform offers a free always-on worker, and this is what
   * a zero-cost launch costs. It is a deliberate, reversible trade: changing
   * this value back and redeploying restores the original topology exactly,
   * because both paths are built and both are tested.
   */
  MEDIA_DISPATCH: z.enum(['queue', 'inline']).default('queue'),

  /**
   * Bearer token for the scheduled-jobs endpoint (ADR-0023).
   *
   * Optional in the schema and closed by default in the route: unset means
   * every call is refused. That is the opposite of `HEALTH_CHECK_TOKEN`, which
   * still answers without one, and deliberately so — a probe that is a little
   * informative beats an unmonitored deployment, but an open endpoint that
   * deletes storage objects beats nothing at all.
   *
   * Required in production when `MEDIA_DISPATCH=inline`, since the redrive is
   * the only thing standing between a failed encode and a lost photograph.
   * The cross-field rule below enforces that.
   */
  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 characters').optional(),

  /**
   * Runs the pilot with no email at all (ADR-0024).
   *
   * It exists to disable a guard, so it is named after what it costs rather
   * than after what it enables. With it set, `MAIL_DRIVER=noop` is permitted in
   * production and **nothing is ever sent**: no verification link, no password
   * reset, no notice that a guest replied. An account stays `unverified`, which
   * means it can sign in and edit but cannot publish, until somebody redeems
   * its token by hand.
   *
   * That is a defensible shape for a pilot whose only accounts belong to the
   * owner, and an indefensible one for a product with customers. The rule below
   * still refuses `noop` without it, which is the whole point: the failure this
   * guards against is silent, and silence is what makes it expensive.
   */
  PILOT_NO_EMAIL: z
    .string()
    .optional()
    .transform((value) => value === 'true'),

  MAIL_DRIVER: z.enum(['smtp', 'resend', 'noop']).default('smtp'),
  MAIL_SMTP_URL: z.string().url().optional(),
  /** Required when the driver is `resend`; the cross-field rule below enforces it. */
  MAIL_RESEND_API_KEY: z.string().min(1).optional(),
  /**
   * Where the Resend adapter posts. Defaults to the provider's API.
   *
   * Overridable so a test or a staging environment can send at a sink it
   * controls instead of at the internet. That is what the end-to-end suite
   * uses: with it, registration exercises the real adapter — the request it
   * builds, the tags it sets, the failure it raises — rather than a no-op
   * transport that proves nothing about the code production runs.
   */
  MAIL_RESEND_ENDPOINT: z.string().url().optional(),
  MAIL_FROM_ADDRESS: z.string().email(),
  MAIL_FROM_NAME: NonEmpty.default('Zfaf'),

  // ISO 3166-1 alpha-2. Which market is active is configuration, never a
  // hard-coded assumption — see ADR-0015.
  DEFAULT_MARKET: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/, 'DEFAULT_MARKET must be an ISO 3166-1 alpha-2 code'),

  /**
   * Cloudflare credentials for the kill switch's cache purge (D8.5).
   *
   * Optional, and the absence is handled honestly rather than pretended away:
   * with no zone configured the moderation action still suspends the
   * invitation and the audit entry records that no purge happened. What it
   * must never do is report a purge that did not occur.
   */
  CDN_ZONE_ID: z.string().optional(),
  CDN_API_TOKEN: z.string().optional(),

  SENTRY_DSN: z.string().url().optional(),

  /**
   * Guards the component detail on `/api/health/deep` (docs/14 §11).
   *
   * Optional: without it the probe still answers with an overall verdict, on
   * the grounds that an unmonitored deployment is worse than a slightly
   * informative one. With it, "which dependency is down" requires the token —
   * because that answer is useful to somebody deciding when to attack.
   */
  HEALTH_CHECK_TOKEN: z.string().min(16).optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  • ${i}`).join('\n')}\n\n` +
        'Copy .env.example to .env and fill in the missing values.',
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates a raw environment record.
 *
 * Takes the source as an argument rather than reading `process.env` directly so
 * the function stays pure and testable — the same reason `Clock` is a port
 * rather than a call to `Date.now()`.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  const env = result.data;

  // Cross-field rules that a per-field schema cannot express.
  if (env.MAIL_DRIVER === 'smtp' && !env.MAIL_SMTP_URL) {
    throw new EnvValidationError(['MAIL_SMTP_URL is required when MAIL_DRIVER is "smtp"']);
  }
  if (env.MAIL_DRIVER === 'resend' && !env.MAIL_RESEND_API_KEY) {
    throw new EnvValidationError(['MAIL_RESEND_API_KEY is required when MAIL_DRIVER is "resend"']);
  }

  // Production must never run against the local development defaults.
  if (env.NODE_ENV === 'production') {
    const productionIssues: string[] = [];
    if (env.SESSION_SECRET.includes('replace-me')) {
      productionIssues.push('SESSION_SECRET still holds the placeholder value');
    }
    if (env.TOTP_ENCRYPTION_KEY.includes('replace-me')) {
      productionIssues.push('TOTP_ENCRYPTION_KEY still holds the placeholder value');
    }
    if (env.TOTP_ENCRYPTION_KEY === env.SESSION_SECRET) {
      // Sharing them makes a session-secret rotation invalidate every enrolled
      // authenticator — a routine act with a catastrophic side effect.
      productionIssues.push('TOTP_ENCRYPTION_KEY must not be the same value as SESSION_SECRET');
    }
    if (env.PUBLIC_BASE_URL.startsWith('http://')) {
      productionIssues.push('PUBLIC_BASE_URL must use https in production');
    }
    if (env.STORAGE_DRIVER === 'minio') {
      productionIssues.push('STORAGE_DRIVER "minio" is a local development driver');
    }
    /**
     * `inline` without a redrive loses photographs, quietly.
     *
     * The inline adapter has no retry: a process replaced mid-encode leaves an
     * asset in `processing` and nothing comes back for it. The scheduled
     * `redrive-media` job is what replaces BullMQ's backoff, and it cannot run
     * without this secret — so the pairing is enforced here rather than left
     * as a line in a runbook (ADR-0023 §4).
     */
    if (env.MEDIA_DISPATCH === 'inline' && !env.CRON_SECRET) {
      productionIssues.push(
        'CRON_SECRET is required when MEDIA_DISPATCH is "inline" — without the redrive job, a failed encode is a lost upload',
      );
    }
    /**
     * `noop` mail in production is silent failure by configuration.
     *
     * Nothing throws, nothing logs an error, and a customer waits at an inbox
     * for a verification link that was never sent. Refusing to boot is the
     * only behaviour that surfaces it before a customer does.
     */
    if (env.MAIL_DRIVER === 'noop' && !env.PILOT_NO_EMAIL) {
      productionIssues.push(
        'MAIL_DRIVER "noop" sends nothing — verification and reset links would never arrive. Set PILOT_NO_EMAIL=true to accept that deliberately (ADR-0024)',
      );
    }
    /**
     * And `smtp` is the same failure wearing a plausible name.
     *
     * The enum has listed it since Phase 0 and **no SMTP adapter exists**: the
     * composition root falls back to the no-op transport for it, which in
     * development is a warning and in production would be the silent loss
     * above. Refused here rather than left to be discovered by the first
     * customer who never receives a link.
     *
     * When an SMTP adapter is actually built, delete this rule — not the
     * `noop` one above it.
     */
    if (env.MAIL_DRIVER === 'smtp') {
      productionIssues.push(
        'MAIL_DRIVER "smtp" has no adapter yet — production mail must use "resend"',
      );
    }
    if (productionIssues.length > 0) throw new EnvValidationError(productionIssues);
  }

  return env;
}

let cached: Env | undefined;

/** Parsed environment for the running process. Memoized after first access. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test-only: clears the memoized environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
