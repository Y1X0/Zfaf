import { type Actor, type Membership, type MembershipRole, isStaff } from './actor.js';
import { type TenantScope, tenantScopeFor } from './tenant-scope.js';

/**
 * Resolving the active tenant from untrusted input.
 *
 * A tenant identifier arriving in a URL, a header, a request body or a token
 * claim is **input, not a fact**. Treating it as a fact is the single most
 * common multi-tenant vulnerability: the attacker does not need to break
 * anything, only to change a number.
 *
 * So a requested tenant is always checked against the actor's memberships,
 * loaded server-side. The claim itself is never evidence of anything.
 */

export type TenantResolutionFailure =
  | 'NOT_AUTHENTICATED'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'NOT_A_MEMBER'
  | 'MALFORMED_TENANT_ID'
  | 'NO_MEMBERSHIPS';

export interface TenantContext {
  readonly tenantId: string;
  readonly role: MembershipRole;
  readonly scope: TenantScope;
}

export type TenantResolution =
  | { readonly ok: true; readonly context: TenantContext }
  | { readonly ok: false; readonly failure: TenantResolutionFailure };

/**
 * Membership ids are UUIDs. A value of another shape never reaches a query.
 * Rejecting early also removes any chance of an injection-shaped id being
 * passed through to a driver.
 */
const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWellFormedTenantId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && TENANT_ID_PATTERN.test(candidate);
}

/**
 * Resolves the tenant the actor is asking to act within.
 *
 * `requestedTenantId` is whatever arrived from the client. It is validated for
 * shape, then matched against memberships that were loaded from the database
 * for this actor — never against anything the client supplied.
 *
 * Note what is deliberately absent: there is no "default to the first
 * membership when the request looks odd" path. Silently substituting a tenant
 * is how an authorization bug becomes invisible.
 */
export function resolveTenantContext(actor: Actor, requestedTenantId: unknown): TenantResolution {
  if (actor.kind !== 'user') return { ok: false, failure: 'NOT_AUTHENTICATED' };
  if (actor.status !== 'active') return { ok: false, failure: 'ACCOUNT_NOT_ACTIVE' };

  const scope = tenantScopeFor(actor);
  if (!scope) return { ok: false, failure: 'ACCOUNT_NOT_ACTIVE' };

  // No tenant requested: fall back only when the choice is unambiguous.
  if (requestedTenantId === undefined || requestedTenantId === null) {
    const only = soleMembership(actor.memberships);
    if (!only) return { ok: false, failure: 'NO_MEMBERSHIPS' };
    return { ok: true, context: { tenantId: only.invitationId, role: only.role, scope } };
  }

  if (!isWellFormedTenantId(requestedTenantId)) {
    return { ok: false, failure: 'MALFORMED_TENANT_ID' };
  }

  const membership = actor.memberships.find((m) => m.invitationId === requestedTenantId);

  if (!membership) {
    // Staff are not granted membership by their role. They read across tenants
    // through an explicitly staff-scoped path that is auditable, not by asking
    // for a tenant they do not belong to.
    return { ok: false, failure: 'NOT_A_MEMBER' };
  }

  return {
    ok: true,
    context: { tenantId: membership.invitationId, role: membership.role, scope },
  };
}

function soleMembership(memberships: readonly Membership[]): Membership | null {
  return memberships.length === 1 ? (memberships[0] ?? null) : null;
}

/**
 * Whether an actor may act on a resource that claims to belong to a tenant.
 *
 * The resource's real owner comes from the database row; the claimed tenant
 * comes from the request. Both must agree *and* the actor must be a member —
 * so a forged tenant id cannot make a foreign resource look like the actor's
 * own, and a real membership cannot be pointed at someone else's row.
 */
export function verifiesResourceTenancy(
  actor: Actor,
  claimedTenantId: unknown,
  resource: { readonly id: string; readonly ownerId: string },
): boolean {
  if (actor.kind !== 'user') return false;
  if (actor.status !== 'active') return false;

  if (claimedTenantId !== undefined && claimedTenantId !== null) {
    if (!isWellFormedTenantId(claimedTenantId)) return false;
    if (claimedTenantId !== resource.id) return false;
  }

  if (actor.userId === resource.ownerId) return true;
  if (actor.memberships.some((m) => m.invitationId === resource.id)) return true;

  // Staff reach resources through the staff scope, which is recorded, rather
  // than by presenting a tenant id.
  return isStaff(actor) ? false : false;
}
