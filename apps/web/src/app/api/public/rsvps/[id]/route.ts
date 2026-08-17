import { editRsvp } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { clientIpHash } from '../../../../../server/request-context.js';
import {
  badRequest,
  notFound,
  ok,
  rateLimited,
  readJsonBody,
} from '../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../server/origin.js';

/**
 * `PATCH /api/public/rsvps/{id}` — a guest correcting their own reply (D7.4).
 *
 * The `editToken` handed back at submission is the entire authorisation: a
 * guest has no account, and inventing one for a correction would cost more
 * replies than the correction is worth.
 *
 * Two things keep that safe rather than merely convenient. The token is stored
 * only as a hash and matched inside the update statement, so the database
 * alone does not confer the ability to edit; and the window is twenty-four
 * hours, so a token that leaks later — forwarded in a screenshot, sitting in a
 * browser history — is already inert.
 *
 * A wrong token, an unknown response and a closed window all answer 404. Any
 * distinction would confirm that a given response id exists.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Three corrections is generous for a change of mind and useless for probing. */
const EDIT_RATE_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 } as const;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  const deps = container();
  const ipHash = await clientIpHash();

  const verdict = await deps.rateLimiter.consume(
    `rsvp-edit:${ipHash}`,
    EDIT_RATE_LIMIT.limit,
    EDIT_RATE_LIMIT.windowMs,
    deps.clock.now(),
  );
  if (!verdict.allowed) return rateLimited(verdict.retryAfterSeconds ?? 3600);

  const body = await readJsonBody(request, 16 * 1024);
  if (!body.ok) return body.response;

  const payload =
    body.body !== null && typeof body.body === 'object' && !Array.isArray(body.body)
      ? { ...(body.body as Record<string, unknown>) }
      : {};

  const editToken = payload['editToken'];
  if (typeof editToken !== 'string' || editToken.length === 0) {
    return notFound('Response');
  }
  // Lifted out before the submission reaches a schema that rejects unknown
  // keys — and so the token is never mistaken for content.
  delete payload['editToken'];

  const result = await editRsvp(
    { rsvpId: id, editToken, body: payload },
    { rsvps: deps.rsvps, clock: deps.clock, tokens: deps.tokens },
  );

  if (result.ok) return ok({ rsvpId: result.rsvpId, updated: true });

  switch (result.failure.code) {
    case 'INVALID':
      return badRequest('INVALID', 'Please check the form', { errors: result.failure.errors });
    case 'WINDOW_CLOSED':
      // The one distinction worth making: a guest who is simply too late
      // deserves to be told so, and knowing that a response existed 25 hours
      // ago tells an attacker nothing they could act on.
      return badRequest('WINDOW_CLOSED', 'Replies can only be changed within 24 hours');
    case 'NOT_FOUND':
      return notFound('Response');
  }
}
