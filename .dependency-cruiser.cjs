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
      name: 'storage-sdk-stays-in-its-adapter',
      severity: 'error',
      comment:
        'ADR-0007 (amendment): the AWS/S3 SDK may only be imported by packages/infra/src/storage. Everything else goes through the StorageProvider port, so changing provider stays a one-directory change.',
      from: { pathNot: '^packages/infra/src/storage/' },
      // Matched anywhere in the resolved path, not anchored to
      // `node_modules/`. A package that does not declare the dependency leaves
      // it unresolved and reports the bare specifier, while one that does
      // resolves into pnpm's virtual store
      // (`node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/…`). Anchoring
      // matched neither, so the rule silently never fired — which the
      // guardrail script caught.
      to: { path: '(^|/)@aws-sdk/' },
    },
    {
      name: 'image-library-stays-in-the-worker',
      severity: 'error',
      comment:
        'Sharp is a native dependency and belongs to the processing adapter. packages/core declares the ImageProcessor port; nothing else decodes images.',
      from: { pathNot: '^apps/worker/src/media/' },
      to: { path: '(^|/)sharp(/|$)' },
    },
    {
      name: 'heic-decoder-stays-in-its-module',
      severity: 'error',
      comment:
        'ADR-0019: libheif-js is imported only by the HEIC decoding adapter. Everything else receives raw pixels or an encoded image through the ImageProcessor port.',
      from: { pathNot: '^apps/worker/src/media/heic-decoder\\.ts$' },
      to: { path: '(^|/)libheif-js(/|$)' },
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
          // Test-support modules: imported only by test files, which are
          // excluded from the graph, so they always look unreferenced.
          '(^|/)[a-z0-9-]+-fixture\\.tsx?$',
          '(^|/)src/testing/',
          'apps/[^/]+/src/app/.*/(page|layout|route|error|loading|not-found|template|opengraph-image)\\.tsx?$',
          'apps/[^/]+/src/app/(page|layout)\\.tsx?$',
        ],
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // Anchored to our own workspaces on purpose. An unanchored `/dist/` also
    // matches third-party packages that ship from `dist/` — Sharp among them —
    // which silently removed them from the graph and made every rule about
    // them pass vacuously. The guardrail script is what surfaced this.
    exclude: {
      path: '(\\.(test|spec)\\.[cm]?[jt]sx?$|^(packages|apps)/[^/]+/(tests?|dist)/|/\\.next/)',
    },
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
