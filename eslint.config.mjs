import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import zfaf from 'eslint-plugin-zfaf';

/**
 * Flat ESLint config.
 *
 * The `zfaf/*` rules are not style preferences — each one mechanically enforces
 * an architectural decision that would otherwise erode. See the ADR referenced
 * in every rule's source header.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Build output: `apps/web/public/invitation.js` is emitted by esbuild
      // from the TypeScript in `src/public-page/`, which *is* linted.
      'apps/web/public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { zfaf },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // ADR-0014: feature access is decided by EntitlementService, never by
          // comparing a plan name. Scattered plan checks are how a paying
          // customer ends up locked out of what they bought.
          selector: 'BinaryExpression[operator=/^===?$/] > MemberExpression[property.name="plan"]',
          message:
            'Do not branch on a plan name. Ask EntitlementService instead: ent.can(feature) (ADR-0014).',
        },
      ],

      // Applies everywhere: user content is never raw HTML.
      'zfaf/no-dangerous-html': 'error',
      // Applies everywhere: Prisma stays inside packages/db.
      'zfaf/no-prisma-outside-db': 'error',
      // Applies everywhere: markets are configuration, not literals.
      'zfaf/no-market-literals': 'error',
    },
  },

  // RTL enforcement is scoped to code that emits styling. Applying it to every
  // file would flag unrelated identifiers and train the team to ignore it.
  {
    files: [
      'packages/ui/**/*.{ts,tsx}',
      'packages/invitation-renderer/**/*.{ts,tsx}',
      'apps/web/**/*.{ts,tsx}',
    ],
    rules: {
      'zfaf/no-physical-css-properties': 'error',
    },
  },

  // The domain core stays framework-free so it can be tested in isolation and
  // extracted later without a rewrite (ADR-0001, ADR-0002).
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*', 'react', 'react-dom', '@zfaf/db', '@zfaf/db/*'],
              message:
                'packages/core must not depend on a framework or on data access. Declare a port instead (ADR-0002).',
            },
          ],
        },
      ],
      // A pure, deterministic core: time and randomness arrive as ports.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'The domain core performs no I/O. Use a port.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Inject a Clock port instead of reading the wall clock (ADR-0004).',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'Inject an IdGenerator port instead of using randomness directly (ADR-0004).',
        },
      ],
    },
  },

  {
    files: ['**/*.{test,spec}.{ts,tsx,mjs}', '**/tests/**/*.{ts,tsx,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-properties': 'off',
    },
  },

  // The rule definitions themselves must name the values they detect.
  {
    files: ['tools/eslint-plugin-zfaf/**/*.js'],
    rules: {
      'zfaf/no-market-literals': 'off',
      'zfaf/no-physical-css-properties': 'off',
    },
  },

  {
    files: ['tools/**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
