import { getEnv } from '@zfaf/config';

import { failure } from './responses.js';

/**
 * Cross-site request forgery, layer 2 (docs/09 §5, docs/04 §2).
 *
 * `SameSite=Lax` on the session cookie is layer 1 and covers the majority. It
 * is not sufficient on its own, and docs/09 says so in a warning box: a
 * mutating `GET` slips past it. We have no mutating `GET` — that is layer 1's
 * other half, and the IDOR matrix would notice — but "we currently have none"
 * is a property of today's route tree, not a guarantee about tomorrow's.
 *
 * So every mutating handler checks the `Origin` header against an allowlist.
 *
 * ## The one subtlety worth stating
 *
 * **A missing `Origin` is allowed.** That looks like a hole and is not: every
 * browser sends `Origin` on a cross-origin mutating request, and on same-origin
 * `POST` too. What omits it is a non-browser client — curl, a monitoring probe,
 * a mobile app — and none of those carries our cookie ambiently, which is the
 * whole mechanism CSRF depends on. Rejecting a missing header would break every
 * legitimate non-browser caller while stopping no attack a browser can mount.
 *
 * ## What is on the allowlist
 *
 *   • `PUBLIC_BASE_URL` — the canonical address.
 *   • The request's own host, forwarded headers included. This is what makes a
 *     custom invitation domain (FR-D11) work without a second allowlist to keep
 *     in sync, and it grants nothing: an attacker who can set the `Host` header
 *     to their own domain is not going through a victim's browser.
 */

/**
 * Refuses a cross-site mutating request, or returns null to continue.
 *
 * Returns a response rather than throwing so a handler's first line reads
 * `const blocked = requireSameOrigin(request); if (blocked) return blocked;` —
 * the same shape as every other guard in this layer.
 */
export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin');
  // See above: absent means non-browser, which is not the threat model.
  if (!origin) return null;

  if (allowedOrigins(request).has(normalise(origin))) return null;

  // 403, not 404: unlike an authorization failure this reveals nothing about
  // what exists — the caller already knows the endpoint's address, because
  // they just posted to it.
  return failure(403, 'FORBIDDEN', 'Cross-site requests are not accepted');
}

/** Lower-cased, without a trailing slash, so `HTTPS://X/` and `https://x` match. */
function normalise(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/$/, '');
  }
}

function allowedOrigins(request: Request): ReadonlySet<string> {
  const allowed = new Set<string>();

  try {
    allowed.add(normalise(getEnv().PUBLIC_BASE_URL));
  } catch {
    // A partial environment is a startup problem, not a reason to accept a
    // cross-site write. The request's own host below still applies.
  }

  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost ?? request.headers.get('host');
  if (host) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    allowed.add(normalise(`${proto}://${host}`));
    // The terminator may forward the proto and the browser may still be on the
    // other one during local development; both spellings of our own host are
    // the same host either way.
    allowed.add(normalise(`http://${host}`));
    allowed.add(normalise(`https://${host}`));
  }

  return allowed;
}
