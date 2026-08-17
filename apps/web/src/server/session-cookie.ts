import { SESSION_COOKIE_NAME, SESSION_TTL_MS, STAFF_SESSION_TTL_MS } from '@zfaf/core';

/**
 * Setting and clearing the session cookie (ADR-0006, docs/09 §2).
 *
 * One place, because a cookie written with slightly different attributes in two
 * handlers is two cookies, and the browser will happily keep both.
 *
 * ## `__Host-`, and what it costs us
 *
 * The prefix is not decoration. A browser refuses to store a `__Host-` cookie
 * unless it is `Secure`, has `Path=/`, and carries **no `Domain`** — which
 * means a compromised subdomain cannot write a cookie our origin will read.
 * Subdomain takeover is the single most common way a session-cookie scheme
 * fails, and this closes it at the browser rather than in our code.
 *
 * What it costs: the whole test suite has to run over TLS, because the browser
 * will silently drop the cookie otherwise. That is why the end-to-end
 * environment terminates real TLS instead of serving plain HTTP — testing with
 * a weakened cookie would test a cookie production does not ship.
 */

export interface SessionCookieOptions {
  /** Staff sessions live hours, not weeks (docs/09 §7). */
  readonly isStaff: boolean;
}

/**
 * Attaches a freshly issued session to a response.
 *
 * `Max-Age` mirrors the row's own expiry rather than out-living it. A cookie
 * that survives its session is not a security problem — the server rejects it —
 * but it is a user staring at a logged-out page that still looks logged in.
 */
export function withSessionCookie(
  response: Response,
  token: string,
  options: SessionCookieOptions,
): Response {
  const maxAgeSeconds = Math.floor(
    (options.isStaff ? STAFF_SESSION_TTL_MS : SESSION_TTL_MS) / 1000,
  );

  response.headers.append(
    'set-cookie',
    [
      `${SESSION_COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      // Lax rather than Strict: Strict would drop the cookie when a couple
      // follows the link in their own verification email, which reads as
      // "signing in did not work".
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ].join('; '),
  );
  return response;
}

/**
 * Clears it.
 *
 * The attributes must match the ones it was set with — a browser matches a
 * deletion by name, path and domain, and a mismatch leaves the cookie in place
 * while the response looks like it worked.
 */
export function withClearedSessionCookie(response: Response): Response {
  response.headers.append(
    'set-cookie',
    [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0'].join(
      '; ',
    ),
  );
  return response;
}
