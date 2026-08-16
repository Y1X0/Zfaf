import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{packages,apps,tools}/*/**/*.{test,spec}.{ts,tsx,mjs}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
    },
  },
});
