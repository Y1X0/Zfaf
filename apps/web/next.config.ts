import { join } from 'node:path';

import type { NextConfig } from 'next';

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
  ],
  webpack(config: { resolve?: { extensionAlias?: Record<string, string[]> } }) {
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

export default nextConfig;
