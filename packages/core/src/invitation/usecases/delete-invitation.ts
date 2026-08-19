import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Clock } from '../../ports/clock.js';
import type { InvitationRepository } from '../ports/invitation-repository.js';

export interface DeleteInvitationInput {
  readonly actor: Actor;
  readonly invitationId: string;
  readonly invitationOwnerId: string | null;
}

export interface DeleteInvitationDeps {
  readonly repository: InvitationRepository;
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

  const deleted = await deps.repository.softDelete(input.invitationId, scope, deps.clock.now());
  if (!deleted) {
    return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };
  }

  return { ok: true };
}
