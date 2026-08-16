import { type Actor, type MembershipRole, isStaff } from './actor.js';

/**
 * Tenant scope — the mechanism that makes IDOR hard to write.
 *
 * The problem this solves: a repository method shaped like `findById(id)` is
 * trivially reachable from a route that forgot its authorization check, and the
 * mistake looks like perfectly ordinary code at the call site.
 *
 * So owner-scoped repositories do not expose such a method. Every private read
 * or write requires a `TenantScope`, which can only be built from an `Actor`,
 * and the repository folds the scope into the SQL `WHERE` clause. Forgetting
 * authorization stops being an oversight and becomes a type error.
 *
 * Public reads live on a separate method that returns a different type carrying
 * only publishable fields — so the two paths cannot be confused either.
 */

declare const scopeBrand: unique symbol;

interface TenantScopeFields {
  /** Owner id to constrain on, or null for staff who read across tenants. */
  readonly ownerId: string | null;
  /** Invitation ids the actor may reach through membership. */
  readonly invitationIds: readonly string[];
  /** Staff bypass ownership, but every such read is auditable. */
  readonly isPlatformStaff: boolean;
  readonly actorDescription: string;
}

/**
 * Branded so a plain object literal cannot stand in for a scope. The only ways
 * to obtain one are `tenantScopeFor` (from an authenticated actor) and
 * `systemScope` (for a named background job).
 */
export type TenantScope = TenantScopeFields & { readonly [scopeBrand]: 'TenantScope' };

/**
 * Builds a scope from a user actor.
 *
 * Returns null for anonymous, guest and system actors: none of them may read
 * private tenant data, and returning null forces the caller to deal with that
 * rather than silently receiving an unconstrained scope.
 */
export function tenantScopeFor(actor: Actor): TenantScope | null {
  if (actor.kind !== 'user') return null;
  if (actor.status === 'suspended') return null;

  const staff = isStaff(actor);
  const fields: TenantScopeFields = {
    ownerId: staff ? null : actor.userId,
    invitationIds: actor.memberships.map((m) => m.invitationId),
    isPlatformStaff: staff,
    actorDescription: `user:${actor.userId}`,
  };
  return fields as TenantScope;
}

/**
 * A scope for background jobs.
 *
 * Explicitly named and separate from the user path so that "the retention job
 * needs to see every invitation" can never be spelled the same way as a user
 * request, and so it is obvious in review when a job is granted this reach.
 */
export function systemScope(jobName: string): TenantScope {
  const fields: TenantScopeFields = {
    ownerId: null,
    invitationIds: [],
    isPlatformStaff: true,
    actorDescription: `system:${jobName}`,
  };
  return fields as TenantScope;
}

/** Whether a scope may reach a specific invitation owned by `ownerId`. */
export function scopeCoversInvitation(
  scope: TenantScope,
  invitation: { readonly id: string; readonly ownerId: string },
): boolean {
  if (scope.isPlatformStaff) return true;
  if (scope.ownerId !== null && scope.ownerId === invitation.ownerId) return true;
  return scope.invitationIds.includes(invitation.id);
}

/** The membership role a scope grants, or null when it grants none. */
export function effectiveRole(
  actor: Actor,
  invitation: { readonly id: string; readonly ownerId: string },
): MembershipRole | null {
  if (actor.kind !== 'user') return null;
  if (actor.userId === invitation.ownerId) return 'owner';
  return actor.memberships.find((m) => m.invitationId === invitation.id)?.role ?? null;
}
