import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env.js';

const valid: Record<string, string> = {
  NODE_ENV: 'development',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://zfaf:pw@localhost:5432/zfaf',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'x'.repeat(48),
  TOTP_ENCRYPTION_KEY: 'y'.repeat(48),
  STORAGE_DRIVER: 'minio',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_REGION: 'auto',
  STORAGE_BUCKET_MEDIA: 'zfaf-media',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
  STORAGE_PUBLIC_BASE_URL: 'http://localhost:9000/zfaf-media',
  MAIL_DRIVER: 'smtp',
  MAIL_SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM_ADDRESS: 'no-reply@zfaf.test',
  MAIL_FROM_NAME: 'Zfaf',
  DEFAULT_MARKET: 'SA',
};

describe('parseEnv', () => {
  it('accepts a complete development environment', () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DEFAULT_MARKET).toBe('SA');
  });

  it('fails fast, naming every missing variable at once', () => {
    const { DATABASE_URL: _db, REDIS_URL: _redis, ...incomplete } = valid;

    expect(() => parseEnv(incomplete)).toThrow(EnvValidationError);
    try {
      parseEnv(incomplete);
    } catch (error) {
      const issues = (error as EnvValidationError).issues.join('\n');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('REDIS_URL');
    }
  });

  it('rejects a session secret shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: 'too-short' })).toThrow(EnvValidationError);
  });

  it('rejects a market code that is not ISO 3166-1 alpha-2', () => {
    expect(() => parseEnv({ ...valid, DEFAULT_MARKET: 'sa' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, DEFAULT_MARKET: 'SAU' })).toThrow(EnvValidationError);
  });

  it('requires an SMTP url when the smtp mail driver is selected', () => {
    const { MAIL_SMTP_URL: _omitted, ...withoutSmtp } = valid;
    expect(() => parseEnv(withoutSmtp)).toThrow(/MAIL_SMTP_URL is required/);
  });

  it('refuses development placeholders in production', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      MAIL_DRIVER: 'resend',
      MAIL_RESEND_API_KEY: 're_test_key',
      PUBLIC_BASE_URL: 'https://zfaf.app',
      SESSION_SECRET: 'replace-me-with-at-least-32-characters-of-random',
      TOTP_ENCRYPTION_KEY: 'z'.repeat(48),
      STORAGE_DRIVER: 'r2',
    };
    expect(() => parseEnv(production)).toThrow(/placeholder/);
  });

  it('refuses plaintext http and the local storage driver in production', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      MAIL_DRIVER: 'resend',
      MAIL_RESEND_API_KEY: 're_test_key',
    };
    try {
      parseEnv(production);
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      const issues = (error as EnvValidationError).issues.join('\n');
      expect(issues).toContain('https');
      expect(issues).toContain('minio');
    }
  });

  it('requires a Resend key when the resend driver is selected', () => {
    expect(() => parseEnv({ ...valid, MAIL_DRIVER: 'resend' })).toThrow(/MAIL_RESEND_API_KEY/);
    expect(() =>
      parseEnv({ ...valid, MAIL_DRIVER: 'resend', MAIL_RESEND_API_KEY: 're_x' }),
    ).not.toThrow();
  });

  it('refuses the noop mail driver in production', () => {
    /**
     * Silent failure by configuration.
     *
     * Nothing throws and nothing logs an error — a customer simply waits at an
     * inbox for a verification link that was never sent. Refusing to boot is
     * the only behaviour that surfaces it before a customer does.
     */
    expect(() =>
      parseEnv({
        ...valid,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://zfaf.app',
        STORAGE_DRIVER: 's3',
        MAIL_DRIVER: 'noop',
      }),
    ).toThrow(/noop/);
  });

  it('refuses the smtp driver in production, because no SMTP adapter exists', () => {
    /**
     * The same silent loss as `noop`, under a name that reads like a working
     * transport. The composition root falls back to the no-op service for
     * `smtp`; in development that is a logged warning, and in production it
     * would be a customer waiting at an inbox.
     */
    expect(() =>
      parseEnv({
        ...valid,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://zfaf.app',
        STORAGE_DRIVER: 's3',
        MAIL_DRIVER: 'smtp',
        MAIL_SMTP_URL: 'smtp://mail.example.com:587',
      }),
    ).toThrow(/smtp/);
  });
});
