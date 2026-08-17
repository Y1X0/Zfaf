import { getEnv } from '@zfaf/config';
import { createInvitation, customerScopeFor, getMarket } from '@zfaf/core';

import { container } from '../../../../server/container.js';
import { entitlementsFor } from '../../../../server/entitlements.js';
import { requireSameOrigin } from '../../../../server/origin.js';
import { requireActor } from '../../../../server/request-context.js';
import {
  badRequest,
  conflict,
  created,
  failure,
  forbidden,
  notFound,
  ok,
  rateLimited,
  readJsonBody,
  unauthorized,
} from '../../../../server/responses.js';

/**
 * The invitation collection (docs/04 §invitations, docs/23 §7).
 *
 * `GET` is the dashboard's list; `POST` is the step the product was missing —
 * the builder, the autosave, the publish and the public page all assumed an
 * invitation already existed, and nothing created one. Tests seeded rows
 * straight into the database, so the gap stayed invisible until somebody asked
 * what a new customer does after signing up.
 *
 * Thin, like every other route here: the decision — who may create, whether
 * the plan allows another, which template they may pin to, what a document
 * looks like on day one — belongs to `createInvitation`, and this file owns
 * only HTTP.
 */

/**
 * Creating is cheap to ask for and expensive to serve.
 *
 * The plan limit is the real ceiling — three active invitations — but it is
 * checked *after* a database count, and a client in a loop would run that
 * count as fast as it could. Twenty an hour is beyond any honest use of a
 * three-invitation plan.
 */
const CREATE_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 } as const;

export async function GET(): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  /**
   * A *customer* scope, not merely a tenant scope.
   *
   * This is a collection endpoint, and staff carry `ownerId: null` — the
   * unconstrained scope the admin console is built on. Handing it to
   * `listInScope` here would answer a staff session with every tenant's
   * invitation titles and slugs, from a route with none of `/api/admin`'s
   * protections. Staff read invitations through the console, which gates on a
   * four-hour session age and leaves an audit trail.
   */
  const scope = customerScopeFor(session.actor);
  if (!scope) return forbidden('This is a customer endpoint');

  const invitations = await container().invitations.listInScope(scope);

  return ok({
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      title: invitation.title,
      slug: invitation.slug,
      status: invitation.status,
      eventDate: invitation.eventDate,
      updatedAt: invitation.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const deps = container();
  const verdict = await deps.rateLimiter.consume(
    `invitation:create:${session.actor.kind === 'user' ? session.actor.userId : session.ipHash}`,
    CREATE_RATE_LIMIT.limit,
    CREATE_RATE_LIMIT.windowMs,
    deps.clock.now(),
  );
  if (!verdict.allowed) return rateLimited(verdict.retryAfterSeconds ?? 60);

  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return body.response;

  const payload =
    body.body !== null && typeof body.body === 'object' && !Array.isArray(body.body)
      ? (body.body as Record<string, unknown>)
      : {};

  // Shape only. Every *rule* — the title's length, whether the date is a real
  // day, whether the template exists and is unlocked — is the use case's, so
  // the two cannot disagree about what a valid request is.
  const templateKey = payload['templateKey'];
  if (typeof templateKey !== 'string' || templateKey.length === 0) {
    return badRequest('INVALID_TEMPLATE', 'templateKey is required');
  }
  const title = payload['title'];
  if (typeof title !== 'string') {
    return badRequest('INVALID_TITLE', 'title is required');
  }
  const eventDate = payload['eventDate'];
  if (typeof eventDate !== 'string') {
    return badRequest('INVALID_EVENT_DATE', 'eventDate is required');
  }
  const locale = payload['locale'];
  if (locale !== 'ar' && locale !== 'en') {
    return badRequest('INVALID_LOCALE', 'locale must be ar or en');
  }
  /**
   * The market, and the zone that belongs to it (ADR-0015).
   *
   * Neither is spelled out here. `DEFAULT_MARKET` is configuration and the
   * zone is the market's own `defaultTimezone`, so opening a second market is
   * a registry entry rather than a hunt through route handlers for the
   * country somebody assumed. The lint rule refuses a literal outright, and it
   * was right to: this function had `Asia/Riyadh` in it a moment ago.
   */
  const marketCode =
    typeof payload['marketCode'] === 'string'
      ? payload['marketCode'].toUpperCase()
      : getEnv().DEFAULT_MARKET;
  const market = getMarket(marketCode);
  if (!market || !market.isActive) {
    return badRequest('INVALID_MARKET', 'marketCode is not a market we serve');
  }

  const timezone =
    typeof payload['timezone'] === 'string' ? payload['timezone'] : market.defaultTimezone;
  if (!isKnownTimezone(timezone)) {
    return badRequest('INVALID_TIMEZONE', 'timezone is not an IANA zone this runtime knows');
  }

  const userId = session.actor.kind === 'user' ? session.actor.userId : null;
  if (userId === null) return forbidden('Only a signed-in customer may create an invitation');

  const result = await createInvitation(
    { actor: session.actor, templateKey, title, eventDate, locale, timezone, marketCode },
    {
      repository: deps.invitations,
      templates: deps.templates,
      entitlements: await entitlementsFor(userId),
      ids: deps.ids,
      clock: deps.clock,
    },
  );

  if (!result.ok) {
    switch (result.code) {
      case 'FORBIDDEN':
        return forbidden(result.message);
      case 'TEMPLATE_NOT_FOUND':
        return notFound('Template');
      case 'TEMPLATE_LOCKED':
        return forbidden(result.message);
      case 'PLAN_LIMIT_EXCEEDED':
        // 409, not 403: nothing about the caller is wrong, and the state that
        // refuses them is one they can change by archiving an invitation.
        return conflict('PLAN_LIMIT_EXCEEDED', result.message);
      case 'INVALID_TITLE':
      case 'INVALID_EVENT_DATE':
      case 'LOCALE_NOT_SUPPORTED':
        return badRequest(result.code, result.message);
      default:
        return failure(400, result.code, result.message);
    }
  }

  const { invitation } = result;
  await deps.audit.record(
    {
      actorId: userId,
      actorType: 'user',
      action: 'invitation.created',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { templateKey: invitation.templateKey, locale: invitation.locale },
      ipHash: new TextEncoder().encode(session.ipHash),
    },
    deps.clock.now(),
  );

  return created({
    id: invitation.id,
    title: invitation.title,
    status: invitation.status,
    locale: invitation.locale,
    timezone: invitation.timezone,
    templateKey: invitation.templateKey,
    version: invitation.draftVersion,
  });
}

/**
 * Whether the runtime recognises this zone.
 *
 * The timezone is written into every invitation and drives the countdown on the
 * public page. A typo accepted here becomes a page whose date arithmetic is
 * silently wrong, so it is checked against ICU rather than against a regex —
 * `Asia/Riyadh` and `Asia/Riadh` are the same shape and only one is a place.
 */
function isKnownTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
