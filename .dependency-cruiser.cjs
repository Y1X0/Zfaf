'use strict';

/**
 * Module boundaries (ADR-0001).
 *
 * A modular monolith only stays modular if the boundaries are enforced by a
 * tool. These rules are what make later extraction a port rather than a
 * rewrite — see docs/08-backend-architecture.md §12.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-stays-framework-free',
      severity: 'error',
      comment:
        'packages/core must not depend on Next.js, React or the data layer. It declares ports; adapters implement them.',
      from: { path: '^packages/core' },
      to: {
        path: '^(node_modules/(next|react|react-dom|@prisma)|packages/db|apps)',
      },
    },
    {
      name: 'core-owns-no-adapters',
      severity: 'error',
      comment: 'packages/core must not reach into infrastructure packages directly.',
      from: { path: '^packages/core' },
      to: { path: '^(infra|apps)/' },
    },
    {
      name: 'shared-depends-on-nothing',
      severity: 'error',
      comment:
        'packages/shared is the leaf of the graph. Anything it imports would become a dependency of the entire system.',
      from: { path: '^packages/shared' },
      to: { path: '^(packages/(?!shared)|apps/)' },
    },
    {
      name: 'apps-do-not-import-each-other',
      severity: 'error',
      comment: 'Apps communicate through packages, never by reaching into a sibling app.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/(?!$1)([^/]+)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules impossible to reason about or extract.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreferenced modules are usually leftovers.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(package|package-lock)\\.json$',
          '(^|/)index\\.ts$',
          // Next.js discovers these by file-system convention, so nothing
          // imports them explicitly. They are entry points, not leftovers.
          '^apps/[^/]+/(next|vitest|playwright)\\.config\\.[cm]?[jt]s$',
          'apps/[^/]+/src/app/.*/(page|layout|route|error|loading|not-found|template|opengraph-image)\\.tsx?$',
          'apps/[^/]+/src/app/(page|layout)\\.tsx?$',
        ],
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.(test|spec)\\.[cm]?[jt]sx?$|/tests?/|/dist/|/\\.next/)' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
