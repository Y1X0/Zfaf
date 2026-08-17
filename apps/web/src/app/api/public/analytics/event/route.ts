import { recordView } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { clientIpHash } from '../../../../../server/request-context.js';
import { requireSameOrigin } from '../../../../../server/origin.js';

/**
 * `POST /api/public/analytics/event` — one view, counted anonymously (D8.2).
 *
 * ## It always answers 204
 *
 * Not "usually". Not "unless the body is malformed". Always. A wedding guest
 * did not ask to be counted and is not our user; the page they opened must not
 * show a failed request in the console, a red line in the network tab, or any
 * delay because Redis was briefly unreachable. Every refusal — bad body,
 * unknown slug, suspended invitation, rate limit, dead buffer — comes back as
 * the same empty `204`.
 *
 * That does mean this endpoint tells a caller nothing, which is also the point:
 * a beacon that reported "unknown slug" separately from "not published" would
 * be a free oracle for probing which invitations exist.
 *
 * ## What it does not do
 *
 * It sets no cookie, reads no cookie, and returns no `Set-Cookie` header. The
 * public page must show zero cookies in a browser inspection (M8 exit
 * criteria), and this is the only endpoint it calls that could have broken
 * that. The visitor's IP is read from the proxy header, mixed into a hash with
 * a salt that expires in a day, and never stored, logged or returned
 * (ADR-0009).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * From docs/04 §12: a hundred a minute per visitor.
 *
 * Generous, because a real person opening one invitation sends one of these.
 * It exists to stop a single client inflating a couple's numbers, not to
 * police normal use — and when it trips, the answer is still `204`.
 */
const PER_VISITOR = { limit: 100, windowMs: 60 * 1000 } as const;

/** A beacon body is two short strings. Anything larger is not one. */
const MAX_BODY_BYTES = 1024;

/** The one response this route produces. */
function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      // Nothing about this response is worth keeping, and a cached 204 would
      // silently stop a browser from sending the next beacon.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  try {
    const deps = container();
    const ipHash = await clientIpHash();

    const gate = await deps.rateLimiter.consume(
      `analytics:${ipHash}`,
      PER_VISITOR.limit,
      PER_VISITOR.windowMs,
      deps.clock.now(),
    );
    if (!gate.allowed) return noContent();

    const body = await readBeaconBody(request);
    if (body === null) return noContent();

    /**
     * The visitor's address, used and dropped.
     *
     * Read here rather than inside the use case so that the one place it
     * appears in this file is the line that hands it to the hash. It is not
     * assigned to anything that outlives the call and it is not part of any
     * response.
     */
    const ip = clientAddress(request);

    await recordView(
      { beacon: body, ip, userAgent: request.headers.get('user-agent') },
      {
        invitations: deps.invitations,
        salt: deps.salt,
        buffer: deps.analyticsBuffer,
        clock: deps.clock,
      },
    );

    return noContent();
  } catch {
    // The contract is unconditional. A thrown error here would still be a 500
    // on somebody's wedding invitation, so it is caught and answered the same
    // way as everything else.
    return noContent();
  }
}

/**
 * Reads the beacon body in either form `sendBeacon` may produce.
 *
 * `navigator.sendBeacon` sends a `Blob` or a string; both arrive as text, and
 * neither carries a JSON content type reliably. So the body is read as text
 * and parsed, bounded first — an unbounded `request.text()` on a public
 * endpoint buffers whatever a caller decides to send.
 */
async function readBeaconBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }

  // The header was a claim; this is the fact.
  if (raw.length > MAX_BODY_BYTES) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The visitor's address as the proxy reports it.
 *
 * Left-most entry of `x-forwarded-for` is the client; everything after is our
 * own infrastructure. A spoofed header only affects which bucket a hash falls
 * into — it cannot leak anything, because nothing derived from it is ever
 * returned or stored.
 */
function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  return forwarded.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}
