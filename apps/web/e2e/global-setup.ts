/**
 * Global setup: verify that Redis and PostgreSQL are available.
 *
 * Without these services, ~380 of 439 e2e tests silently skip. This check
 * fails loudly instead, so the issue is visible rather than hidden in a
 * summary line that reads "55 passed, exit code 1".
 *
 * docs/13-testing-strategy.md § 4.5 explains what does and does not run.
 */

async function globalSetup() {
  // Skip check if testing against a remote deployment
  if (process.env['E2E_BASE_URL']) {
    return;
  }

  const dbUrl = process.env['DATABASE_URL'] ?? 'postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public';
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

  try {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 2000 });
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    await pool.end();
  } catch (e) {
    console.error('\n❌ PostgreSQL is not available at', dbUrl);
    console.error('   E2E tests require a running PostgreSQL database.');
    console.error('   Without it, ~380 of 439 tests will not run.\n');
    console.error('   To start PostgreSQL:\n');
    console.error('   $ docker run -d -e POSTGRES_USER=zfaf -e POSTGRES_PASSWORD=zfaf_local_dev \\');
    console.error('     -e POSTGRES_DB=zfaf -p 5432:5432 postgres:16-alpine\n');
    process.exit(1);
  }

  try {
    const { createClient } = await import('redis');
    const redis = createClient({ url: redisUrl, socket: { reconnectStrategy: () => null } });
    await redis.connect();
    await redis.ping();
    await redis.disconnect();
  } catch (e) {
    console.error('\n❌ Redis is not available at', redisUrl);
    console.error('   E2E tests require a running Redis cache.');
    console.error('   Without it, ~380 of 439 tests will not run.\n');
    console.error('   To start Redis:\n');
    console.error('   $ docker run -d -p 6379:6379 redis:7-alpine\n');
    process.exit(1);
  }
}

export default globalSetup;
