import { getEnv } from '@zfaf/config';
import { publicInvitationUrl, submitRsvp } from '@zfaf/core';

import { container } from '../../../../../../server/container.js';
import { clientIpHash } from '../../../../../../server/request-context.js';
import { HUMAN_CHECK_THRESHOLD } from '../../../../../../server/turnstile.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  ok,
  rateLimited,
} from '../../../../../../server/responses.js';
import { requireSameOrigin } from '../../../../../../server/origin.js';

/**
 * `POST /api/public/invitations/{slug}/rsvp` — a guest replying (D7.1–D7.3).
 *
 * ## Why the slug, and not the invitation id
 *
 * The specification writes this path with `{id}`, but the public identity of
 * an invitation is its slug: it is what `/i/{slug}` uses, what a QR code
 * encodes, and what a guest actually holds. Accepting a UUID here would put
 * internal identifiers on an unauthenticated surface for no gain, and an
 * endpoint keyed on ids is an enumeration oracle. Same capability, narrower
 * exposure.
 *
 * ## Why it answers in two formats
 *
 * The public page ships no framework (ADR-0020), so the RSVP form is a native
 * `<form method="post">` that must work with JavaScript switched off. A form
 * post is answered with **303 See Other** back to the invitation — the
 * post/redirect/get pattern, so a guest who reloads does not resubmit — and a
 * `fetch` from the enhancement script is answered with JSON.
 *
 * One handler, because two would be two places for the rules to drift.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** From docs/04 §4: five per ten minutes per visitor, twenty an hour per invitation. */
const PER_VISITOR = { limit: 5, windowMs: 10 * 60 * 1000 } as const;
const PER_INVITATION = { limit: 20, windowMs: 60 * 60 * 1000 } as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const { slug } = await context.params;
  const deps = container();
  const now = deps.clock.now();

  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const contentType = request.headers.get('content-type') ?? '';
  const isForm =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');

  const ipHash = await clientIpHash();

  // ── rate limits, before anything is parsed ────────────────────────────────

  const visitor = await deps.rateLimiter.consume(
    `rsvp:${ipHash}:${slug}`,
    PER_VISITOR.limit,
    PER_VISITOR.windowMs,
    now,
  );
  if (!visitor.allowed) {
    return respond(request, slug, wantsJson || !isForm, {
      json: () => rateLimited(visitor.retryAfterSeconds ?? 600),
      redirectParam: 'rate',
    });
  }

  const invitationWindow = await deps.rateLimiter.consume(
    `rsvp:invitation:${slug}`,
    PER_INVITATION.limit,
    PER_INVITATION.windowMs,
    now,
  );
  if (!invitationWindow.allowed) {
    return respond(request, slug, wantsJson || !isForm, {
      json: () => rateLimited(invitationWindow.retryAfterSeconds ?? 3600),
      redirectParam: 'rate',
    });
  }

  /**
   * Whether this invitation is busy enough to warrant a challenge.
   *
   * `peek` rather than `consume`: this is a reading of how hot the invitation
   * is, not another attempt against the budget. Consuming here would make the
   * threshold interfere with the limit above.
   */
  const pressure = await deps.rateLimiter.peek(
    `rsvp:pressure:${slug}`,
    HUMAN_CHECK_THRESHOLD.limit,
    HUMAN_CHECK_THRESHOLD.windowMs,
    now,
  );
  await deps.rateLimiter.consume(
    `rsvp:pressure:${slug}`,
    HUMAN_CHECK_THRESHOLD.limit,
    HUMAN_CHECK_THRESHOLD.windowMs,
    now,
  );

  // ── the body, in whichever encoding arrived ───────────────────────────────

  const parsed = await readBody(request, isForm);
  if (!parsed.ok) {
    return respond(request, slug, wantsJson || !isForm, {
      json: () => badRequest('MALFORMED_BODY', 'Could not read the reply'),
      redirectParam: 'invalid',
    });
  }

  const { fields } = parsed;
  // The honeypot and the challenge token are transport concerns, so they are
  // lifted out before the submission reaches a schema that rejects unknown
  // keys.
  const honeypot = typeof fields['website'] === 'string' ? fields['website'] : null;
  const humanCheckToken =
    typeof fields['turnstileToken'] === 'string' ? fields['turnstileToken'] : null;
  delete fields['website'];
  delete fields['turnstileToken'];

  const result = await submitRsvp(
    {
      slug,
      body: fields,
      honeypot,
      requiresHumanCheck: !pressure.allowed,
      humanCheckToken,
    },
    {
      invitations: deps.invitations,
      rsvps: deps.rsvps,
      clock: deps.clock,
      ids: deps.ids,
      tokens: deps.tokens,
      humanCheck: deps.humanCheck,
      notifyOwner: deps.notifyRsvp,
    },
  );

  const asJson = wantsJson || !isForm;

  if (result.ok) {
    // The honeypot outcome is deliberately indistinguishable from success: a
    // bot told it failed simply tries differently.
    if ('discarded' in result) {
      return respond(request, slug, asJson, {
        json: () => ok({ message: 'Thanks — your reply has been recorded.' }),
        redirectParam: 'ok',
      });
    }

    return respond(request, slug, asJson, {
      json: () =>
        ok(
          {
            rsvpId: result.rsvpId,
            created: result.created,
            // Handed over once. It is the only way a guest can correct their
            // own answer, and it is never readable from the database.
            editToken: result.editToken,
          },
          { status: 201 },
        ),
      redirectParam: 'ok',
    });
  }

  // Bound once so TypeScript keeps the narrowing across the closures below.
  const outcome = result.failure;

  switch (outcome.code) {
    case 'NOT_FOUND':
      return respond(request, slug, asJson, {
        json: () => notFound('Invitation'),
        redirectParam: 'closed',
      });
    case 'HUMAN_CHECK_REQUIRED':
      return respond(request, slug, asJson, {
        json: () => forbidden('Please complete the check and try again'),
        redirectParam: 'check',
      });
    case 'REFUSED':
      // 409, not 400: the reply is well formed, and it is the invitation's
      // current state — replies closed, deadline passed, party too large —
      // that refuses it. A guest can act on that; a validation error would
      // send them looking for a typo that is not there.
      return respond(request, slug, asJson, {
        json: () => conflict('RSVP_REFUSED', refusalMessage(), { reason: outcome.reason }),
        redirectParam: 'closed',
      });
    case 'INVALID':
      return respond(request, slug, asJson, {
        // The issues describe our own rules, not another guest's data.
        json: () => badRequest('INVALID', 'Please check the form', { errors: outcome.errors }),
        redirectParam: 'invalid',
      });
  }
}

function refusalMessage(): string {
  return 'This invitation is not accepting replies';
}

/**
 * Answers as JSON, or as a redirect for a browser that posted a form.
 *
 * 303 rather than 302, and back to the invitation with a status in the query:
 * a guest who reloads the page after replying must not resubmit, and without
 * JavaScript the query parameter is the only way the page can know to show a
 * confirmation.
 */
function respond(
  request: Request,
  slug: string,
  asJson: boolean,
  reply: { json: () => Response; redirectParam: string },
): Response {
  // The JSON branch builds its own status. It used to receive one alongside
  // and ignore it, which quietly turned every refusal into a 400 — the sort of
  // defect that only a test asserting the *specific* status will catch.
  if (asJson) return reply.json();

  const base = publicBaseUrl(request);
  const target = `${publicInvitationUrl(base, slug)}?rsvp=${reply.redirectParam}#rsvp`;
  return new Response(null, {
    status: 303,
    headers: { location: target, 'cache-control': 'no-store' },
  });
}

function publicBaseUrl(request: Request): string {
  try {
    return getEnv().PUBLIC_BASE_URL;
  } catch {
    return new URL(request.url).origin;
  }
}

/** Reads either encoding into a plain object, bounded before it is parsed. */
async function readBody(
  request: Request,
  isForm: boolean,
): Promise<{ ok: true; fields: Record<string, unknown> } | { ok: false }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  // A reply is a name and a note. Anything larger is not a reply.
  if (Number.isFinite(declared) && declared > 16 * 1024) return { ok: false };

  try {
    if (isForm) {
      const form = await request.formData();
      const fields: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        // Files are never expected here; accepting one would let a client turn
        // a text field into an upload.
        if (typeof value === 'string') fields[key] = value;
      }
      return { ok: true, fields };
    }

    const raw = await request.text();
    if (raw.length > 16 * 1024) return { ok: false };
    const body: unknown = JSON.parse(raw);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
    return { ok: true, fields: { ...(body as Record<string, unknown>) } };
  } catch {
    return { ok: false };
  }
}
