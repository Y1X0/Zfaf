import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The renderer's tests are .tsx and render real components to static markup.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['{packages,apps,tools}/*/**/*.{test,spec}.{ts,tsx,mjs}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/e2e/**',
      'packages/*/tests/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
    },
  },
});
