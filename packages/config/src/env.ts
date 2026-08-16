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

  STORAGE_DRIVER: z.enum(['minio', 'r2', 's3']).default('minio'),
  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: NonEmpty.default('auto'),
  STORAGE_BUCKET_MEDIA: NonEmpty,
  STORAGE_ACCESS_KEY_ID: NonEmpty,
  STORAGE_SECRET_ACCESS_KEY: NonEmpty,
  STORAGE_PUBLIC_BASE_URL: z.string().url(),

  MAIL_DRIVER: z.enum(['smtp', 'resend', 'noop']).default('smtp'),
  MAIL_SMTP_URL: z.string().url().optional(),
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

  // Production must never run against the local development defaults.
  if (env.NODE_ENV === 'production') {
    const productionIssues: string[] = [];
    if (env.SESSION_SECRET.includes('replace-me')) {
      productionIssues.push('SESSION_SECRET still holds the placeholder value');
    }
    if (env.PUBLIC_BASE_URL.startsWith('http://')) {
      productionIssues.push('PUBLIC_BASE_URL must use https in production');
    }
    if (env.STORAGE_DRIVER === 'minio') {
      productionIssues.push('STORAGE_DRIVER "minio" is a local development driver');
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
