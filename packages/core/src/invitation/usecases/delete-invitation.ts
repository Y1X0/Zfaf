import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import type { InvitationRepository } from '../ports/invitation-repository.js';
import type { MediaRepository } from '../../media/ports/media-repository.js';

export interface DeleteInvitationInput {
  readonly actor: Actor;
  readonly invitationId: string;
  readonly invitationOwnerId: string | null;
}

export interface DeleteInvitationDeps {
  readonly repository: InvitationRepository;
  readonly media: MediaRepository;
  readonly clock: Clock;
}

export type DeleteInvitationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

export async function deleteInvitation(
  input: DeleteInvitationInput,
  deps: DeleteInvitationDeps,
): Promise<DeleteInvitationResult> {
  const decision = can(input.actor, 'invitation:delete', {
    kind: 'invitation',
    id: input.invitationId,
    ownerId: input.invitationOwnerId ?? '',
  });
  if (!decision.allowed) {
    return { ok: false, code: decision.reason, message: 'Not permitted to delete this invitation' };
  }

  const scope = tenantScopeFor(input.actor);
  if (!scope) {
    return { ok: false, code: 'NO_TENANT_SCOPE', message: 'Not permitted' };
  }

  const now = deps.clock.now();
  const deleted = await deps.repository.softDelete(input.invitationId, scope, now);
  if (!deleted) {
    return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };
  }

  // TODO: softDelete and orphanByInvitation are not atomic. If orphanByInvitation
  // fails or the process dies between calls, media is never marked orphaned. The
  // orphaned media is then never purged: quota leaks silently and permanently.
  // Long-term fix: wrap both in a transaction or have the purge job find media by
  // invitation.deletedAt state rather than relying on orphanedAt.
  await deps.media.orphanByInvitation(input.invitationId, now);

  return { ok: true };
}
