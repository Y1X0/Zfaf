import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import type { InvitationRepository } from '../ports/invitation-repository.js';
import {
  type PatchOperation,
  type PatchViolation,
  applyPatch,
  conflictingPaths,
  validatePatch,
} from '../domain/document-patch.js';

/**
 * Autosave (D5.5, D5.7).
 *
 * Three things happen here, in this order, and the order is the design:
 *
 *   1. **Authorise.** Through `can()`, like every other write.
 *   2. **Validate the patch against the allowlist.** Before the document is
 *      read, before a version is compared — because a patch naming `/status`
 *      is not a request to be reconciled, it is one to be refused and
 *      recorded.
 *   3. **Apply optimistically.** The repository writes only if the version is
 *      still what the client built on, so two devices cannot silently
 *      overwrite one another.
 *
 * A rejected patch is reported to the audit sink, not merely returned. The
 * builder never produces a forbidden path, so one arriving means either a
 * broken client or someone probing the endpoint, and both are worth knowing.
 */

export interface UpdateDraftInput {
  readonly actor: Actor;
  readonly invitationId: string;
  /** The version the client's document was built on. */
  readonly baseVersion: number;
  /** Untrusted: an RFC 6902 patch straight off the wire. */
  readonly patch: unknown;
}

/** What a refused patch is recorded as. Deliberately not a free-form string. */
export interface PatchAuditEntry {
  readonly actorId: string | null;
  readonly actorDescription: string;
  readonly invitationId: string;
  readonly violations: readonly PatchViolation[];
  readonly at: Date;
}

export interface UpdateDraftDeps {
  readonly repository: InvitationRepository;
  readonly clock: Clock;
  /**
   * Where a refused patch is reported.
   *
   * Injected rather than written directly so the domain stays framework-free,
   * and so a test can assert that the recording happened — a rejection nobody
   * hears about is indistinguishable from one that never occurred.
   */
  readonly recordRejection: (entry: PatchAuditEntry) => Promise<void>;
}

export type UpdateDraftResult =
  | {
      readonly ok: true;
      readonly version: number;
      readonly savedAt: Date;
      /** The paths this call wrote, so the client can reason about conflicts. */
      readonly appliedPaths: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_PATCH' | 'PATCH_FAILED';
      readonly message: string;
      readonly violations?: readonly PatchViolation[];
    }
  | {
      readonly ok: false;
      readonly code: 'VERSION_CONFLICT';
      readonly message: string;
      readonly currentVersion: number;
      readonly currentDocument: unknown;
      /**
       * The subset of the client's paths that overlap what changed on the
       * server. Empty means the two edits are disjoint and the client may
       * merge silently (docs/06 §4.3).
       */
      readonly conflictingPaths: readonly string[];
    };

export async function updateDraftDocument(
  input: UpdateDraftInput,
  deps: UpdateDraftDeps,
): Promise<UpdateDraftResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) {
    return { ok: false, code: 'FORBIDDEN', message: 'Not permitted to edit this invitation' };
  }

  const invitation = await deps.repository.findByIdInScope(input.invitationId, scope);
  if (!invitation) {
    return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };
  }

  const decision = can(input.actor, 'invitation:update', {
    kind: 'invitation',
    id: invitation.id,
    ownerId: invitation.ownerId,
  });
  if (!decision.allowed) {
    return { ok: false, code: 'FORBIDDEN', message: 'Not permitted to edit this invitation' };
  }

  const validation = validatePatch(input.patch);
  if (!validation.ok) {
    // Recorded before returning. This is the audit trail the milestone's
    // mandatory security test asserts on: a patch naming `/status` or
    // `/ownerId` must be both refused *and* visible afterwards.
    await deps.recordRejection({
      actorId: input.actor.kind === 'user' ? input.actor.userId : null,
      actorDescription: scope.actorDescription,
      invitationId: invitation.id,
      violations: validation.violations,
      at: deps.clock.now(),
    });

    return {
      ok: false,
      code: 'INVALID_PATCH',
      message: 'Patch was refused',
      violations: validation.violations,
    };
  }

  const paths = validation.operations.map((operation) => operation.path);

  if (invitation.draftVersion !== input.baseVersion) {
    // Someone else — usually the same person on another device — wrote first.
    // The client gets everything it needs to decide: the current document, the
    // current version, and precisely which of *its* paths overlap.
    return {
      ok: false,
      code: 'VERSION_CONFLICT',
      message: 'This invitation changed since your last save',
      currentVersion: invitation.draftVersion,
      currentDocument: invitation.draftDocument,
      conflictingPaths: conflictingPaths(
        paths,
        changedPathsBetween(invitation.draftDocument, paths),
      ),
    };
  }

  const patched = applyPatch(invitation.draftDocument, validation.operations as PatchOperation[]);
  if (!patched.ok) {
    return {
      ok: false,
      code: 'PATCH_FAILED',
      message: `Operation ${patched.index} could not be applied to "${patched.path}" (${patched.error})`,
    };
  }

  const now = deps.clock.now();
  const outcome = await deps.repository.updateDraft(
    invitation.id,
    scope,
    patched.document,
    input.baseVersion,
    now,
  );

  if (!outcome.ok) {
    if (outcome.error === 'VERSION_CONFLICT') {
      // Lost the race between the read above and the write. The same
      // information the client would have got a moment earlier.
      const fresh = await deps.repository.findByIdInScope(input.invitationId, scope);
      return {
        ok: false,
        code: 'VERSION_CONFLICT',
        message: 'This invitation changed while your save was in flight',
        currentVersion: outcome.currentVersion ?? fresh?.draftVersion ?? input.baseVersion,
        currentDocument: fresh?.draftDocument ?? null,
        conflictingPaths: paths,
      };
    }
    return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };
  }

  return { ok: true, version: outcome.draftVersion, savedAt: now, appliedPaths: paths };
}

/**
 * Which of the client's paths might have moved on the server.
 *
 * We do not keep a per-path change log — that would be a second source of
 * truth to maintain — so this errs toward reporting a conflict: every path the
 * client touched that still exists in the server's document is treated as
 * possibly contended. The client then intersects that with what it changed.
 *
 * The cost of erring this way is an occasional unnecessary dialog. The cost of
 * erring the other way is a silently discarded edit, which is the failure this
 * whole mechanism exists to prevent.
 */
function changedPathsBetween(serverDocument: unknown, clientPaths: readonly string[]): string[] {
  return clientPaths.filter((path) => pointerExists(serverDocument, path));
}

function pointerExists(document: unknown, pointer: string): boolean {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return false;
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current as Record<string, unknown>, segment)) return false;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return false;
    }
  }
  return true;
}
