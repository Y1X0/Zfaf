import type { InvitationStatus } from '../../invitation/domain/invitation-status.js';

/**
 * What the admin console may read (D8.6, D8.7).
 *
 * A separate port from the tenant repositories, and separate on purpose. Those
 * take a `TenantScope` and constrain every query to it; this one deliberately
 * reads across tenants, which is precisely why it must not be reachable from
 * the same interface an ordinary request holds. Making it a distinct type
 * means "this code can see everybody's data" is visible in an import line.
 *
 * Two properties are load-bearing:
 *
 *   • **Read-only.** There is no update or delete here. The one thing an
 *     operator may change in M8 — an invitation's moderation status — goes
 *     through `moderateInvitation`, which authorises, records an audit entry
 *     and purges the edge cache. A second write path would be a way around
 *     all three.
 *   • **No guest data.** No method returns a name, a phone number or a note
 *     from `rsvps`. Staff may see that an invitation has forty replies; they
 *     may not see who. That is a product decision the owner ratified
 *     (docs/09 §3.3) and it is enforced here structurally, not by remembering
 *     to leave a column out of a `SELECT`.
 */

export interface AdminUserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
  readonly status: string;
  readonly emailVerified: boolean;
  readonly invitationCount: number;
  readonly createdAt: Date;
}

export interface AdminInvitationRow {
  readonly id: string;
  readonly slug: string | null;
  /**
   * Addresses this invitation used to answer on (ADR-0013).
   *
   * Needed by the kill switch: each one still answers 301, that redirect is
   * cacheable, and a printed QR code carries an old address forever. Empty for
   * an invitation that was never renamed, which is most of them.
   */
  readonly previousSlugs: readonly string[];
  readonly title: string;
  readonly status: InvitationStatus;
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly eventDate: string;
  /** How many people replied. A count, never the replies themselves. */
  readonly rsvpCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminAuditRow {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorType: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

export interface AdminPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

export interface AdminUserFilter {
  readonly query?: string | undefined;
  readonly status?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminInvitationFilter {
  readonly query?: string | undefined;
  readonly status?: InvitationStatus | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminAuditFilter {
  readonly action?: string | undefined;
  readonly actorId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminRepository {
  listUsers(filter: AdminUserFilter): Promise<AdminPage<AdminUserRow>>;
  listInvitations(filter: AdminInvitationFilter): Promise<AdminPage<AdminInvitationRow>>;
  listAuditLog(filter: AdminAuditFilter): Promise<AdminPage<AdminAuditRow>>;
  /** The one lookup the kill switch needs before it can act. */
  findInvitationForModeration(id: string): Promise<AdminInvitationRow | null>;
}
