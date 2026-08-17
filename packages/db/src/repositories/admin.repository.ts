import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AdminAuditFilter,
  AdminAuditRow,
  AdminInvitationFilter,
  AdminInvitationRow,
  AdminPage,
  AdminRepository,
  AdminUserFilter,
  AdminUserRow,
  InvitationStatus,
} from '@zfaf/core';

/**
 * Prisma implementation of the admin console's reads (D8.6, D8.7).
 *
 * The one repository in the system that deliberately reads across tenants,
 * which makes what it *cannot* return the important part:
 *
 *   • **No guest data.** Replies are counted with `_count`, never selected.
 *     There is no code path here that could produce a guest's name, phone
 *     number or note, so the rule from docs/09 §3.4 holds structurally rather
 *     than by everyone remembering it.
 *   • **No password hashes, tokens or session material.** The user projection
 *     is written out field by field for the same reason `toUserRecord` is: a
 *     spread would carry a new sensitive column upward the day somebody adds
 *     one.
 *   • **No writes.** Suspending an invitation goes through
 *     `moderateInvitation`, which authorises, audits and purges the edge
 *     cache. A write here would be a way around all three.
 *
 * Searches are `contains` rather than full-text, and that is honest for the
 * scale: an operator looking up one account by address does not need a GIN
 * index, and adding one now would be a maintenance burden for a screen a
 * handful of people open. The `mode: 'insensitive'` matters more — support
 * staff type addresses the way the customer said them, not the way they were
 * stored.
 */
export class PrismaAdminRepository implements AdminRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listUsers(filter: AdminUserFilter): Promise<AdminPage<AdminUserRow>> {
    // The status filter arrives from a query string, so it is matched against
    // the schema's own set rather than passed through. An unrecognised value
    // means "no status filter", not a database error on an admin screen.
    const status = asUserStatus(filter.status);

    const where: Prisma.UserWhereInput = {
      ...(status ? { status } : {}),
      ...(filter.query
        ? {
            OR: [
              { email: { contains: filter.query, mode: 'insensitive' } },
              { name: { contains: filter.query, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filter.limit,
        skip: filter.offset,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          emailVerifiedAt: true,
          createdAt: true,
          _count: { select: { invitations: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        status: row.status,
        emailVerified: row.emailVerifiedAt !== null,
        invitationCount: row._count.invitations,
        createdAt: row.createdAt,
      })),
      total,
    };
  }

  async listInvitations(filter: AdminInvitationFilter): Promise<AdminPage<AdminInvitationRow>> {
    const where: Prisma.InvitationWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.query
        ? {
            OR: [
              { slug: { contains: filter.query, mode: 'insensitive' } },
              { title: { contains: filter.query, mode: 'insensitive' } },
              { owner: { email: { contains: filter.query, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.invitation.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: filter.limit,
        skip: filter.offset,
        select: INVITATION_SELECT,
      }),
      this.prisma.invitation.count({ where }),
    ]);

    return { rows: rows.map(toInvitationRow), total };
  }

  async findInvitationForModeration(id: string): Promise<AdminInvitationRow | null> {
    const row = await this.prisma.invitation.findUnique({
      where: { id },
      select: INVITATION_SELECT,
    });
    return row ? toInvitationRow(row) : null;
  }

  async listAuditLog(filter: AdminAuditFilter): Promise<AdminPage<AdminAuditRow>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.actorId ? { actorId: filter.actorId } : {}),
      ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filter.limit,
        skip: filter.offset,
        select: {
          id: true,
          actorId: true,
          actorType: true,
          action: true,
          resourceType: true,
          resourceId: true,
          metadata: true,
          createdAt: true,
          // `ipHash` is deliberately absent. It exists so an incident can be
          // correlated, not so an operator can browse it on a screen.
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorType: row.actorType,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        metadata: row.metadata,
        createdAt: row.createdAt,
      })),
      total,
    };
  }
}

const USER_STATUSES = ['active', 'suspended', 'pending_deletion'] as const;

function asUserStatus(value: string | undefined): (typeof USER_STATUSES)[number] | undefined {
  return value && (USER_STATUSES as readonly string[]).includes(value)
    ? (value as (typeof USER_STATUSES)[number])
    : undefined;
}

const INVITATION_SELECT = {
  id: true,
  slug: true,
  title: true,
  status: true,
  ownerId: true,
  eventDate: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { email: true } },
  /**
   * Every address this invitation used to answer on (ADR-0013).
   *
   * Read for the kill switch: each old slug still answers 301, that redirect
   * is cacheable, and a printed QR code carries an old address forever — so a
   * purge that cleared only the current one would leave the most durable route
   * to a suspended page working. Ordered oldest-first so the audit trail reads
   * chronologically.
   */
  slugHistory: { select: { oldSlug: true }, orderBy: { changedAt: 'asc' } },
  // A count, never the rows. This is the line that keeps guest data out of the
  // admin console.
  _count: { select: { rsvps: true } },
} satisfies Prisma.InvitationSelect;

type InvitationRow = Prisma.InvitationGetPayload<{ select: typeof INVITATION_SELECT }>;

function toInvitationRow(row: InvitationRow): AdminInvitationRow {
  return {
    id: row.id,
    slug: row.slug,
    previousSlugs: row.slugHistory.map((entry) => entry.oldSlug),
    title: row.title,
    status: row.status as InvitationStatus,
    ownerId: row.ownerId,
    ownerEmail: row.owner.email,
    // A calendar date, and it stays one. Handing a `Date` upward would make an
    // invitation on the 20th render as the 19th for anyone west of UTC.
    eventDate: row.eventDate.toISOString().slice(0, 10),
    rsvpCount: row._count.rsvps,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
