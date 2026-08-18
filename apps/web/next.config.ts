import { join } from 'node:path';

import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Points the plugin at our request config (D9.1).
 *
 * The path is passed explicitly because the file lives under `src/i18n/`
 * rather than at one of the two locations next-intl probes by default. Without
 * it the build compiles cleanly and then fails at prerender with "couldn't
 * find next-intl config file" — a failure that only appears once a page is
 * actually generated.
 */
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Security headers applied to every response.
 * The per-surface CSP (strictest on the public invitation page) lands with the
 * public route in M6 — see docs/12-security-threat-model.md §4.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keeps the build portable across hosts; the migration plan in
  // docs/16-cost-estimate.md §4 depends on not binding to one platform.
  output: 'standalone',
  transpilePackages: [
    '@zfaf/core',
    '@zfaf/shared',
    '@zfaf/config',
    '@zfaf/db',
    '@zfaf/infra',
    '@zfaf/invitation-renderer',
    '@zfaf/media-client',
    '@zfaf/media-processing',
  ],
  /**
   * Files the tracer cannot see.
   *
   * Prisma loads its query engine by path at runtime, so nothing statically
   * references the `.so.node` binary and the standalone trace leaves it
   * behind. The failure only appears once the standalone server actually
   * queries — which is to say, in production rather than in `next build`.
   */
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
  outputFileTracingIncludes: {
    '/**/*': [
      '../../packages/db/node_modules/.prisma/client/**',
      '../../node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/*.node',
    ],
    // The link-preview card is rasterised from a font file read at runtime, so
    // nothing statically references it and the tracer cannot see it. Without
    // this, every preview falls back to the generic card in production while
    // looking perfect in development.
    '/i/[slug]/og/route': ['./assets/fonts/Amiri-Regular.ttf'],
  },

  // Native and heavyweight modules stay on the Node runtime rather than being
  // bundled. Webpack cannot parse a `.node` binary, and bundling the Prisma or
  // S3 clients would inline megabytes into every route that imports the
  // composition root.
  serverExternalPackages: [
    '@node-rs/argon2',
    '@prisma/client',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    // A Rust binding; webpack cannot parse a `.node` binary.
    '@resvg/resvg-js',
    // ADR-0023: reachable from the request path when `MEDIA_DISPATCH=inline`.
    // Both are native — Sharp's libvips binding and libheif's emscripten
    // build — and both must stay on the Node runtime.
    'sharp',
    'libheif-js',
  ],
  webpack(
    config: {
      resolve?: { extensionAlias?: Record<string, string[]> };
      externals?: unknown[];
    },
    { isServer }: { isServer: boolean },
  ) {
    // Our TypeScript is configured for NodeNext, so every relative import ends
    // in `.js` even though the file on disk is `.ts`. `tsc` resolves that;
    // webpack does not, and the failure only appears once a workspace package
    // is pulled into the bundle rather than merely typechecked.
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };

    /**
     * Argon2 stays external, explicitly.
     *
     * `serverExternalPackages` already names it, and that is not enough here:
     * the import arrives through `@zfaf/infra`, which is in
     * `transpilePackages`, and webpack follows a transpiled package's imports
     * rather than consulting the external list. It then reaches the
     * platform-specific `.node` binaries — `argon2.android-arm-eabi.node` and
     * a dozen siblings — and cannot parse them.
     *
     * Declaring the external here catches the specifier wherever it comes from.
     * Server-only, because the client bundle must never see it at all.
     */
    if (isServer) {
      config.externals ??= [];
      config.externals.push({ '@node-rs/argon2': 'commonjs @node-rs/argon2' });
      // Sharp and libheif arrive the same way and need the same treatment:
      // through `@zfaf/media-processing`, which is transpiled, so webpack
      // follows the import instead of consulting `serverExternalPackages`
      // and then meets a `.node` binary it cannot parse (ADR-0023).
      config.externals.push({ sharp: 'commonjs sharp' });
      config.externals.push({ 'libheif-js': 'commonjs libheif-js' });
    }

    return config;
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // The builder embeds this route in an iframe, so a blanket DENY would
        // break the preview. Relaxed to SAMEORIGIN and no further: nothing
        // outside our own origin may frame a private draft.
        source: '/preview/:path*',
        headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
