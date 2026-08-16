import { defineConfig } from 'vitest/config';

/**
 * Integration tests.
 *
 * Separate from the unit config because these require a real PostgreSQL
 * instance. They run serially: several of them assert on concurrency and
 * constraint behaviour, which parallel workers sharing one database would make
 * non-deterministic.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
