import createMiddleware from 'next-intl/middleware';

import { routing } from './i18n/routing.js';

/**
 * Locale routing (D9.1).
 *
 * Its job is to decide which locale a page request belongs to. What matters
 * more here is the matcher — **which requests it must never touch**:
 *
 *   • **`/i/…`** — the published invitation. Its language comes from the
 *     invitation, not the visitor (ADR-0011 §2), and it is a Route Handler
 *     that assembles its own document with a nonce and a strict CSP. Locale
 *     negotiation would be pointless at best and would rewrite the URL at
 *     worst — the address printed on a QR code.
 *   • **`/api/…`** — machine surfaces. A JSON error carries a stable code the
 *     client translates, and a `Vary: Accept-Language` on the RSVP endpoint
 *     would fragment its cache for nothing.
 *   • **`/admin`** — the internal console.
 *   • **`/_next`, `/_vercel`, anything with a file extension** — assets.
 *
 * The exclusions are written out rather than inferred, because "the middleware
 * started rewriting a route that must not be rewritten" shows up as a broken
 * printed QR code rather than as a test failure.
 *
 * ⚠️ This middleware only behaves correctly when the server's `HOSTNAME`
 * matches the host Next uses to build the middleware's request URL. Next
 * derives that URL from `fetchHostname || 'localhost'` and separately derives
 * the base it compares rewrites against from the configured hostname; when the
 * two differ, every rewrite here is classified as *external* and re-proxied
 * over the network, which behind TLS termination fails outright. That was the
 * D9.1 defect, and `e2e/locale-routing.spec.ts` is what stops it returning.
 * See `scripts/start-standalone.mjs`.
 */

export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|admin|i/|_next|_vercel|.*\\..*).*)'],
};
