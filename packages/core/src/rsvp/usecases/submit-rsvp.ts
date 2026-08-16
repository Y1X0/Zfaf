import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { TokenGenerator } from '../../identity/ports/token-generator.js';
import type { InvitationRepository } from '../../invitation/ports/invitation-repository.js';
import { resolvePublicAccess } from '../../invitation/domain/public-access.js';
import {
  type RsvpRefusal,
  type RsvpValidationError,
  checkRsvpPolicy,
  parseRsvpSubmission,
  rsvpDedupeHash,
} from '../domain/rsvp-submission.js';
import type { RsvpRepository } from '../ports/rsvp-repository.js';

/**
 * A guest replying (D7.1–D7.4).
 *
 * The most exposed write in the product: unauthenticated, reachable by anyone
 * who has the link, and holding other people's personal data. The order of
 * checks below is the order the specification requires (docs/04 §4), and each
 * step exists to stop something specific.
 *
 *   1. **Honeypot** — answered with a convincing success. A bot that is told
 *      it failed simply tries differently; one that believes it succeeded goes
 *      away. Nothing is written.
 *   2. **Human check**, when the caller reports the invitation is under
 *      suspicion. Injected as a port so the domain does not know what
 *      Turnstile is.
 *   3. **Shape** — Zod, before the invitation is loaded, because a malformed
 *      body should not cost a database read.
 *   4. **The invitation's own rules** — read from the *published snapshot*.
 *      The form is markup a guest can edit; the snapshot is what the couple
 *      published, and `maxPartySize` is enforced from it every single time.
 *   5. **Identity** — a hash of invitation, name and phone, so a guest who
 *      double-taps on a poor connection updates their answer instead of
 *      inflating the count.
 *
 * Rate limiting sits in the route rather than here, because it is keyed on an
 * IP hash the domain deliberately never sees.
 */

export type SubmitRsvpFailure =
  | { readonly code: 'INVALID'; readonly errors: readonly RsvpValidationError[] }
  | { readonly code: 'REFUSED'; readonly reason: RsvpRefusal }
  | { readonly code: 'NOT_FOUND' }
  | { readonly code: 'HUMAN_CHECK_REQUIRED' };

export type SubmitRsvpResult =
  | {
      readonly ok: true;
      readonly rsvpId: string;
      readonly created: boolean;
      /**
       * Returned once, never stored in readable form.
       *
       * It lets a guest correct their own answer for 24 hours without an
       * account, which is the only mechanism they have.
       */
      readonly editToken: string;
    }
  /** The honeypot outcome: indistinguishable from success, and writes nothing. */
  | { readonly ok: true; readonly discarded: true }
  | { readonly ok: false; readonly failure: SubmitRsvpFailure };

export interface SubmitRsvpInput {
  /** Resolved from the public slug by the caller. */
  readonly slug: string;
  /** Untrusted, straight off the wire. */
  readonly body: unknown;
  /** The honeypot field. Anything non-empty means a bot filled it. */
  readonly honeypot: string | null;
  /** Whether the caller has already decided a human check is needed. */
  readonly requiresHumanCheck: boolean;
  /** The token the client supplied for that check, if any. */
  readonly humanCheckToken: string | null;
  readonly source?: string;
}

export interface HumanCheck {
  verify(token: string | null): Promise<boolean>;
}

export interface SubmitRsvpDeps {
  readonly invitations: InvitationRepository;
  readonly rsvps: RsvpRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly tokens: TokenGenerator;
  readonly humanCheck: HumanCheck;
  /** Fired after a successful write; a failure here must not fail the reply. */
  readonly notifyOwner?: (event: RsvpNotification) => Promise<void>;
}

export interface RsvpNotification {
  readonly invitationId: string;
  readonly rsvpId: string;
  readonly guestName: string;
  readonly attending: boolean;
  readonly partySize: number;
  readonly at: Date;
}

/** 32 bytes, like every other token the system issues (ADR-0006). */
export const RSVP_EDIT_TOKEN_BYTES = 32;

/** A guest may correct their own answer for a day (D7.4). */
export const RSVP_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function submitRsvp(
  input: SubmitRsvpInput,
  deps: SubmitRsvpDeps,
): Promise<SubmitRsvpResult> {
  // 1 — the honeypot, before anything costs us a query.
  if (input.honeypot !== null && input.honeypot.trim().length > 0) {
    return { ok: true, discarded: true };
  }

  // 2 — the human check, when the caller says this invitation is under load.
  if (input.requiresHumanCheck && !(await deps.humanCheck.verify(input.humanCheckToken))) {
    return { ok: false, failure: { code: 'HUMAN_CHECK_REQUIRED' } };
  }

  // 3 — shape.
  const parsed = parseRsvpSubmission(input.body);
  if (!parsed.ok) return { ok: false, failure: { code: 'INVALID', errors: parsed.errors } };

  // 4 — the invitation, and its own rules.
  const view = await deps.invitations.findPublishedBySlug(input.slug);
  if (!view) return { ok: false, failure: { code: 'NOT_FOUND' } };

  const now = deps.clock.now();
  const access = resolvePublicAccess({
    status: view.status,
    expiresAt: view.expiresAt,
    now,
  });
  // An invitation a guest may not even read certainly may not be replied to,
  // and the answer is the same 404 the page gives — a different one here would
  // tell a stranger which slugs exist.
  if (access.kind !== 'VISIBLE') return { ok: false, failure: { code: 'NOT_FOUND' } };

  const refusal = checkRsvpPolicy({
    enabled: view.snapshot.content.rsvp.enabled,
    deadline: view.snapshot.content.rsvp.deadline,
    maxPartySize: view.snapshot.content.rsvp.maxPartySize,
    submission: parsed.submission,
    now,
    timezone: view.snapshot.content.wedding.timezone,
  });
  if (refusal) return { ok: false, failure: { code: 'REFUSED', reason: refusal } };

  // 5 — identity, then the write.
  const editToken = deps.tokens.generate(RSVP_EDIT_TOKEN_BYTES);
  const outcome = await deps.rsvps.submit({
    id: deps.ids.uuid(),
    invitationId: view.invitationId,
    name: parsed.submission.name,
    attending: parsed.submission.attending,
    partySize: parsed.submission.attending ? parsed.submission.partySize : 0,
    phone: parsed.submission.phone,
    note: parsed.submission.note,
    dedupeHash: rsvpDedupeHash({
      invitationId: view.invitationId,
      name: parsed.submission.name,
      phone: parsed.submission.phone,
    }),
    editTokenHash: deps.tokens.hash(editToken),
    source: input.source ?? 'public',
    now,
  });

  if (!outcome.ok) return { ok: false, failure: { code: 'NOT_FOUND' } };

  if (deps.notifyOwner) {
    try {
      await deps.notifyOwner({
        invitationId: view.invitationId,
        rsvpId: outcome.rsvpId,
        guestName: parsed.submission.name,
        attending: parsed.submission.attending,
        partySize: parsed.submission.partySize,
        at: now,
      });
    } catch {
      // A guest's reply is recorded whatever the mail server is doing. Losing
      // the notification is a nuisance; losing the reply is the product
      // failing at the one thing it exists for.
    }
  }

  return { ok: true, rsvpId: outcome.rsvpId, created: outcome.created, editToken };
}

// ── the owner's side (D7.5) ─────────────────────────────────────────────────

export interface ListRsvpsInput {
  readonly actor: Actor;
  readonly invitationId: string;
  readonly attending?: boolean | undefined;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export type ListRsvpsResult =
  | {
      readonly ok: true;
      readonly rows: Awaited<ReturnType<RsvpRepository['listInScope']>>['rows'];
      readonly total: number;
    }
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'NOT_FOUND' };

/** A page's worth. Large enough for a wedding, small enough to bound a query. */
export const RSVP_PAGE_MAX = 100;
/** The export ceiling. Well above any real wedding, and still bounded. */
export const RSVP_EXPORT_MAX = 5000;

export interface RsvpReadDeps {
  readonly invitations: InvitationRepository;
  readonly rsvps: RsvpRepository;
}

/**
 * The couple's list of replies.
 *
 * Authorised through `rsvp:read`, which `can()` classifies as guest data —
 * and guest data is the one category **platform staff cannot read**, however
 * senior. Support can help with a broken link; they have no business knowing
 * who is going to somebody's wedding.
 */
export async function listRsvps(
  input: ListRsvpsInput,
  deps: RsvpReadDeps,
): Promise<ListRsvpsResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN' };

  const invitation = await deps.invitations.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND' };

  const decision = can(input.actor, 'rsvp:read', {
    kind: 'invitation',
    id: invitation.id,
    ownerId: invitation.ownerId,
  });
  if (!decision.allowed) return { ok: false, code: 'FORBIDDEN' };

  const page = await deps.rsvps.listInScope(invitation.id, scope, {
    ...(input.attending === undefined ? {} : { attending: input.attending }),
    ...(input.query === undefined ? {} : { query: input.query }),
    limit: clamp(input.limit ?? 50, 1, RSVP_PAGE_MAX),
    offset: Math.max(0, input.offset ?? 0),
  });

  return { ok: true, rows: page.rows, total: page.total };
}

export type RsvpStatsResult =
  | {
      readonly ok: true;
      readonly stats: NonNullable<Awaited<ReturnType<RsvpRepository['statsInScope']>>>;
    }
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'NOT_FOUND' };

export async function rsvpStats(
  input: { actor: Actor; invitationId: string },
  deps: RsvpReadDeps,
): Promise<RsvpStatsResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN' };

  const invitation = await deps.invitations.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND' };

  if (
    !can(input.actor, 'rsvp:read', {
      kind: 'invitation',
      id: invitation.id,
      ownerId: invitation.ownerId,
    }).allowed
  ) {
    return { ok: false, code: 'FORBIDDEN' };
  }

  const stats = await deps.rsvps.statsInScope(invitation.id, scope);
  return stats ? { ok: true, stats } : { ok: false, code: 'NOT_FOUND' };
}

export type ExportRsvpsResult =
  | {
      readonly ok: true;
      readonly rows: Awaited<ReturnType<RsvpRepository['allInScope']>>;
      readonly locale: 'ar' | 'en';
      readonly slug: string | null;
    }
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'NOT_FOUND' };

/** Export is a separate permission: reading a list and taking it away differ. */
export async function exportRsvps(
  input: { actor: Actor; invitationId: string },
  deps: RsvpReadDeps,
): Promise<ExportRsvpsResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN' };

  const invitation = await deps.invitations.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND' };

  if (
    !can(input.actor, 'rsvp:export', {
      kind: 'invitation',
      id: invitation.id,
      ownerId: invitation.ownerId,
    }).allowed
  ) {
    return { ok: false, code: 'FORBIDDEN' };
  }

  const rows = await deps.rsvps.allInScope(invitation.id, scope, RSVP_EXPORT_MAX);
  return { ok: true, rows, locale: invitation.locale, slug: invitation.slug };
}

export type DeleteRsvpResult =
  { readonly ok: true } | { readonly ok: false; readonly code: 'FORBIDDEN' | 'NOT_FOUND' };

export async function deleteRsvp(
  input: { actor: Actor; invitationId: string; rsvpId: string },
  deps: RsvpReadDeps & { clock: Clock },
): Promise<DeleteRsvpResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return { ok: false, code: 'FORBIDDEN' };

  const invitation = await deps.invitations.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND' };

  if (
    !can(input.actor, 'rsvp:delete', {
      kind: 'invitation',
      id: invitation.id,
      ownerId: invitation.ownerId,
    }).allowed
  ) {
    return { ok: false, code: 'FORBIDDEN' };
  }

  const removed = await deps.rsvps.deleteInScope(
    input.rsvpId,
    invitation.id,
    scope,
    deps.clock.now(),
  );
  return removed ? { ok: true } : { ok: false, code: 'NOT_FOUND' };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// ── correcting a reply (D7.4) ───────────────────────────────────────────────

export interface EditRsvpInput {
  readonly rsvpId: string;
  readonly editToken: string;
  readonly body: unknown;
}

export type EditRsvpResult =
  | { readonly ok: true; readonly rsvpId: string }
  | {
      readonly ok: false;
      readonly failure:
        | { readonly code: 'INVALID'; readonly errors: readonly RsvpValidationError[] }
        | { readonly code: 'NOT_FOUND' }
        | { readonly code: 'WINDOW_CLOSED' };
    };

export interface EditRsvpDeps {
  readonly rsvps: RsvpRepository;
  readonly clock: Clock;
  readonly tokens: TokenGenerator;
}

/**
 * A guest correcting their own reply, with no account.
 *
 * The token is the whole authorisation, so three properties matter and each is
 * enforced somewhere it cannot be skipped:
 *
 *   • It is **stored hashed**, like every token the system issues (ADR-0006),
 *     so the database alone does not let anyone edit replies.
 *   • It is matched **inside the update statement**, not read and compared
 *     here — a check-then-write would be a race, and comparing in application
 *     code invites a non-constant-time comparison.
 *   • The **window is passed to the repository** rather than checked here for
 *     the same reason: the predicate belongs in the statement that writes.
 *
 * A wrong token and a missing response answer identically. Distinguishing them
 * would confirm that a given response id exists.
 */
export async function editRsvp(input: EditRsvpInput, deps: EditRsvpDeps): Promise<EditRsvpResult> {
  const parsed = parseRsvpSubmission(input.body);
  if (!parsed.ok) return { ok: false, failure: { code: 'INVALID', errors: parsed.errors } };

  const now = deps.clock.now();
  const outcome = await deps.rsvps.edit({
    rsvpId: input.rsvpId,
    editTokenHash: deps.tokens.hash(input.editToken),
    attending: parsed.submission.attending,
    partySize: parsed.submission.attending ? parsed.submission.partySize : 0,
    note: parsed.submission.note,
    now,
    editableUntil: new Date(now.getTime() - RSVP_EDIT_WINDOW_MS),
  });

  if (outcome.ok) return { ok: true, rsvpId: outcome.rsvpId };

  return {
    ok: false,
    failure: outcome.error === 'WINDOW_CLOSED' ? { code: 'WINDOW_CLOSED' } : { code: 'NOT_FOUND' },
  };
}
