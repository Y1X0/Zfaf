import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration (M5 acceptance).
 *
 * Two projects, and the split is the point of the suite rather than a
 * convenience: the default viewport is a **390px phone**, because that is
 * where roughly 40% of couples build their invitation and where a
 * "responsive enough" layout actually fails. The desktop project only
 * verifies that the wider split-pane layout appears.
 *
 * Chromium comes from the image rather than being downloaded. The bundled
 * build does not always match what the installed `@playwright/test` expects,
 * so the binary is named explicitly — otherwise every run fails asking for a
 * download this environment will not do.
 */

/** The image's Chromium. Overridable for a machine that manages its own. */
const executablePath = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

const PORT = Number(process.env['E2E_PORT'] ?? 3100);
// HTTPS, because the session cookie is `__Host-` prefixed and browsers refuse
// that prefix over plain HTTP. Testing over HTTP would have meant weakening
// the cookie for tests, which is the one thing a security test must not do.
const baseURL = `https://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Serial: the tests share one database and one server, and a flake caused by
  // parallel writes would be indistinguishable from a real defect.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],

  use: {
    baseURL,
    // The certificate is self-signed and generated per run; the transport is
    // real TLS, which is all the cookie prefix cares about.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    locale: 'ar',
    timezoneId: 'UTC',
  },

  projects: [
    {
      name: 'mobile-390',
      use: {
        ...devices['Desktop Chrome'],
        // The acceptance width, exactly. Not "a small viewport".
        viewport: { width: 390, height: 844 },
        isMobile: false,
        hasTouch: true,
        launchOptions: { executablePath },
      },
      testIgnore: /desktop\.spec\.ts/,
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions: { executablePath },
      },
      testMatch: /desktop\.spec\.ts/,
    },
  ],

  webServer: {
    // The standalone production server — the same one we deploy. `next start`
    // refuses to run against `output: 'standalone'`, and a development server
    // behaves differently enough under server components and bundling that
    // testing it would prove the wrong thing.
    command: `pnpm start:e2e`,
    /**
     * A complete environment, because the app validates all of it at startup
     * (`packages/config`) and refuses to run on a partial one — which is the
     * behaviour we want in production and therefore the behaviour the tests
     * have to satisfy rather than bypass.
     *
     * The storage and mail values point nowhere real: these tests exercise the
     * builder, and an upload or an email would be a different suite. Nothing
     * here is a secret.
     */
    env: {
      PORT: String(PORT),
      // Next inlines NODE_ENV at build time, so the app sees `production`
      // whatever is set here — and the production guards in `packages/config`
      // apply in full. The values below satisfy them honestly rather than
      // relaxing them: HTTPS, a real secret, and a production storage driver.
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: baseURL,
      DATABASE_URL:
        process.env['DATABASE_URL'] ??
        'postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public',
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
      SESSION_SECRET: 'e2e-session-secret-value-at-least-32-characters-long',
      // A *different* value from the session secret, as production requires:
      // sharing them would make a routine session-secret rotation invalidate
      // every enrolled authenticator (docs/09 §2.8).
      TOTP_ENCRYPTION_KEY: 'e2e-totp-encryption-key-at-least-32-characters-long',
      // `s3` rather than `minio`, because the config layer refuses a local
      // development driver in production and it is right to. Nothing in this
      // suite uploads, so the endpoint is never reached.
      STORAGE_DRIVER: 's3',
      STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      STORAGE_REGION: 'auto',
      STORAGE_BUCKET_MEDIA: 'zfaf-media',
      STORAGE_ACCESS_KEY_ID: 'e2e',
      STORAGE_SECRET_ACCESS_KEY: 'e2e-secret',
      STORAGE_PUBLIC_BASE_URL: 'http://127.0.0.1:9000/zfaf-media',
      MAIL_DRIVER: 'noop',
      MAIL_FROM_ADDRESS: 'no-reply@zfaf.test',
      DEFAULT_MARKET: 'SA',
    },
    url: `${baseURL}/api/health`,
    // The readiness probe hits the same self-signed endpoint the tests do.
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
