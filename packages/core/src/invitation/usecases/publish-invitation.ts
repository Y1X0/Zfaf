import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import { type DraftDocument, parseDraftDocument } from '../domain/draft-document.js';
import { Slug, type SlugIssue } from '../domain/slug.js';
import { type ResolveIssue, resolveDocument } from '../domain/resolve-document.js';
import { canTransition } from '../domain/invitation-status.js';
import type { InvitationRepository } from '../ports/invitation-repository.js';

/**
 * Publishing (D6.2).
 *
 * The step that turns a draft anyone may still edit into an immutable record
 * hundreds of guests will read. Everything here exists because that transition
 * is one-way in practice: a link that has gone out cannot be recalled.
 *
 * The order is deliberate.
 *
 *   1. **Authorise**, through `can()`, like every write.
 *   2. **Check the lifecycle.** A suspended invitation cannot be published back
 *      into view by its owner, and the transition table — not an `if` here —
 *      is what says so.
 *   3. **Parse the stored draft.** It is JSONB written by an earlier release
 *      and is treated as untrusted input, not as a `DraftDocument` because the
 *      type says it is.
 *   4. **Resolve the slug.** Before the snapshot is built, so a rejected slug
 *      costs nothing.
 *   5. **Project the document.** `resolveDocument` fails where the preview
 *      would substitute a placeholder.
 *   6. **Write atomically.** Version insert and pointer move in one
 *      transaction; slug uniqueness enforced by the index rather than by a
 *      prior read, because a check-then-write lets two simultaneous publishes
 *      both pass the check.
 *
 * Republishing is the same operation. There is no separate "update the live
 * version" path, because there is no such thing: every publish appends a new
 * immutable version and moves the pointer (ADR-0005).
 */

export interface PublishInvitationInput {
  readonly actor: Actor;
  readonly invitationId: string;
  /** Untrusted. Absent means "keep the slug this invitation already has". */
  readonly slug?: string | undefined;
  /** Optional automatic expiry; absent leaves the current setting alone. */
  readonly expiresAt?: Date | null | undefined;
}

export interface PublishAuditEntry {
  readonly actorId: string | null;
  readonly invitationId: string;
  readonly action: 'publish' | 'republish' | 'unpublish' | 'rollback';
  readonly slug: string | null;
  readonly versionNumber: number | null;
  readonly previousSlug: string | null;
  readonly at: Date;
}

export interface PublishDeps {
  readonly repository: InvitationRepository;
  readonly clock: Clock;
  readonly recordPublication: (entry: PublishAuditEntry) => Promise<void>;
}

export type PublishInvitationResult =
  | {
      readonly ok: true;
      readonly slug: string;
      readonly versionId: string;
      readonly versionNumber: number;
      readonly publishedAt: Date;
      /** True the first time; the owner-facing copy differs (ADR-0017). */
      readonly firstPublication: boolean;
    }
  | {
      readonly ok: false;
      readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'SLUG_TAKEN';
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: 'INVALID_SLUG';
      readonly message: string;
      readonly issue: SlugIssue;
    }
  | {
      readonly ok: false;
      readonly code: 'NOT_READY';
      readonly message: string;
      readonly issues: readonly ResolveIssue[];
    };

export async function publishInvitation(
  input: PublishInvitationInput,
  deps: PublishDeps,
): Promise<PublishInvitationResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) return forbidden();

  const invitation = await deps.repository.findByIdInScope(input.invitationId, scope);
  if (!invitation) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };

  const resource = { kind: 'invitation' as const, id: invitation.id, ownerId: invitation.ownerId };
  if (!can(input.actor, 'invitation:publish', resource).allowed) return forbidden();

  const republishing = invitation.status === 'PUBLISHED';
  const transition = canTransition(invitation.status, republishing ? 'republish' : 'publish', {
    isStaff: scope.isPlatformStaff,
  });
  if (!transition.ok) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `An invitation that is ${invitation.status.toLowerCase()} cannot be published`,
    };
  }

  // ── the slug ──────────────────────────────────────────────────────────────

  const requested = input.slug?.trim();
  const changingSlug = requested !== undefined && requested !== invitation.slug;

  if (changingSlug && !can(input.actor, 'invitation:change_slug', resource).allowed) {
    return forbidden();
  }

  const slugResult = resolveSlug(requested, invitation.slug, invitation.draftDocument);
  if (!slugResult.ok) {
    return {
      ok: false,
      code: 'INVALID_SLUG',
      message: 'Slug is not usable',
      issue: slugResult.issue,
    };
  }

  // ── the document ──────────────────────────────────────────────────────────

  // The stored draft is JSONB from an earlier release, so it is parsed rather
  // than asserted. A document that no longer fits the schema must fail loudly
  // at publish time, in front of the owner, not silently at render time in
  // front of guests.
  const parsed = parseDraftDocument(invitation.draftDocument);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'NOT_READY',
      message: 'The saved draft could not be read',
      issues: parsed.errors.map((error) => ({
        field: error,
        messageKey: 'publish.unreadableDraft',
      })),
    };
  }

  const now = deps.clock.now();
  const resolved = resolveDocument(parsed.document, { publishedAt: now.toISOString() });
  if (!resolved.ok) {
    return {
      ok: false,
      code: 'NOT_READY',
      message: 'The invitation is missing something guests need',
      issues: resolved.issues,
    };
  }

  // ── the write ─────────────────────────────────────────────────────────────

  const outcome = await deps.repository.publish(
    {
      invitationId: invitation.id,
      slug: slugResult.slug.value,
      snapshot: resolved.snapshot,
      publishedBy: input.actor.kind === 'user' ? input.actor.userId : invitation.ownerId,
      expiresAt: input.expiresAt === undefined ? invitation.expiresAt : input.expiresAt,
      now,
    },
    scope,
  );

  if (!outcome.ok) {
    if (outcome.error === 'SLUG_TAKEN') {
      return {
        ok: false,
        code: 'SLUG_TAKEN',
        message: 'That address is already in use',
      };
    }
    return {
      ok: false,
      code: outcome.error,
      message: outcome.error === 'NOT_FOUND' ? 'Invitation not found' : 'Illegal transition',
    };
  }

  await deps.recordPublication({
    actorId: input.actor.kind === 'user' ? input.actor.userId : null,
    invitationId: invitation.id,
    action: republishing ? 'republish' : 'publish',
    slug: slugResult.slug.value,
    versionNumber: outcome.versionNumber,
    previousSlug: changingSlug ? invitation.slug : null,
    at: now,
  });

  return {
    ok: true,
    slug: slugResult.slug.value,
    versionId: outcome.versionId,
    versionNumber: outcome.versionNumber,
    publishedAt: now,
    firstPublication: invitation.publishedVersionId === null,
  };
}

/**
 * Which slug this publish uses.
 *
 * Three sources in order: what the owner typed, what the invitation already
 * has, and — only for a first publication where neither exists — a suggestion
 * from the couple's names. The suggestion is a convenience, never a silent
 * rename: an invitation that already has a slug keeps it unless the owner
 * asked otherwise, because the old one is already in people's messages.
 */
function resolveSlug(
  requested: string | undefined,
  current: string | null,
  draftDocument: unknown,
): { ok: true; slug: Slug } | { ok: false; issue: SlugIssue } {
  if (requested !== undefined && requested.length > 0) {
    const parsed = Slug.parse(requested);
    return parsed.ok ? { ok: true, slug: parsed.value } : { ok: false, issue: parsed.error };
  }

  if (current !== null) {
    const parsed = Slug.parse(current);
    return parsed.ok ? { ok: true, slug: parsed.value } : { ok: false, issue: parsed.error };
  }

  const document = parseDraftDocument(draftDocument);
  if (!document.ok) return { ok: false, issue: 'EMPTY_AFTER_NORMALIZATION' };

  const suggested = suggestSlug(document.document);
  return suggested.ok ? { ok: true, slug: suggested.value } : { ok: false, issue: suggested.error };
}

/** Exported so the builder can show the same suggestion the server would pick. */
export function suggestSlug(document: DraftDocument) {
  return Slug.suggestFromNames(
    document.content.couple.groomName,
    document.content.couple.brideName,
  );
}

function forbidden(): PublishInvitationResult {
  return { ok: false, code: 'FORBIDDEN', message: 'Not permitted to publish this invitation' };
}
