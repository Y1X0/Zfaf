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
  transpilePackages: ['@zfaf/core', '@zfaf/shared', '@zfaf/config'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
