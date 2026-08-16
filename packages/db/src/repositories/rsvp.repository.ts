import type { PrismaClient, Prisma } from '@prisma/client';
import {
  type EditRsvpCommand,
  type EditRsvpOutcome,
  type RsvpListFilter,
  type RsvpRecord,
  type RsvpRepository,
  type RsvpStats,
  type SubmitRsvpCommand,
  type SubmitRsvpOutcome,
  type TenantScope,
  counterDelta,
} from '@zfaf/core';

/**
 * Prisma implementation of the RSVP repository (D7.2).
 *
 * The whole of this file exists to make two things true under concurrency,
 * because the milestone's exit criterion is fifty simultaneous submissions —
 * duplicates among them — producing exactly correct counters.
 *
 *   • **One guest, one row.** Enforced by the unique index on
 *     `(invitation_id, dedupe_hash)` and an upsert, not by a prior read. A
 *     check-then-insert loses this race by construction.
 *   • **Counters that never drift.** Every write moves them by a *delta*
 *     inside the same transaction as the row, using `increment` so PostgreSQL
 *     computes the new value. Recounting would need a read, and a read between
 *     two concurrent submissions is exactly how a counter goes wrong.
 */
export class PrismaRsvpRepository implements RsvpRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Turns a scope into a `WHERE` fragment for the owning invitation.
   *
   * Note what is missing: there is no staff branch. Guest data is the one
   * category platform staff may never read (docs/09 §3.4), and the absence of
   * a bypass here is what makes that true rather than merely stated.
   */
  private invitationWhere(invitationId: string, scope: TenantScope): Prisma.InvitationWhereInput {
    const clauses: Prisma.InvitationWhereInput[] = [];
    if (scope.ownerId !== null) clauses.push({ ownerId: scope.ownerId });
    if (scope.invitationIds.length > 0) clauses.push({ id: { in: [...scope.invitationIds] } });

    // A scope granting nothing must match nothing.
    if (clauses.length === 0) return { id: { in: [] } };
    return { AND: [{ id: invitationId }, { deletedAt: null }, { OR: clauses }] };
  }

  private async reachable(invitationId: string, scope: TenantScope): Promise<boolean> {
    return (
      (await this.prisma.invitation.count({ where: this.invitationWhere(invitationId, scope) })) > 0
    );
  }

  // ── the guest's side ──────────────────────────────────────────────────────

  async submit(input: SubmitRsvpCommand): Promise<SubmitRsvpOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await lockInvitation(tx, input.invitationId);

      // Read *after* the lock: the previous answer is what the counter delta is
      // measured from, and under READ COMMITTED an unlocked read cannot see a
      // concurrent transaction's uncommitted insert.
      const previous = await tx.rsvp.findUnique({
        where: {
          invitationId_dedupeHash: {
            invitationId: input.invitationId,
            dedupeHash: Buffer.from(input.dedupeHash),
          },
        },
        select: { id: true, attending: true, partySize: true },
      });

      const delta = counterDelta(previous, {
        attending: input.attending,
        partySize: input.partySize,
      });

      const row = await tx.rsvp.upsert({
        where: {
          invitationId_dedupeHash: {
            invitationId: input.invitationId,
            dedupeHash: Buffer.from(input.dedupeHash),
          },
        },
        create: {
          id: input.id,
          invitationId: input.invitationId,
          name: input.name,
          attending: input.attending,
          partySize: input.partySize,
          phone: input.phone,
          note: input.note,
          dedupeHash: Buffer.from(input.dedupeHash),
          editTokenHash: Buffer.from(input.editTokenHash),
          source: input.source,
          submittedAt: input.now,
          updatedAt: input.now,
        },
        update: {
          // The name is refreshed because the guest may have corrected their
          // own spelling; the identity hash is unchanged by definition, since
          // it is what matched this row.
          name: input.name,
          attending: input.attending,
          partySize: input.partySize,
          phone: input.phone,
          note: input.note,
          // A fresh token: the second submission is the guest's current
          // session, and the link they were given a week ago should not
          // outlive it.
          editTokenHash: Buffer.from(input.editTokenHash),
          updatedAt: input.now,
        },
        select: { id: true },
      });

      await tx.invitation.update({
        where: { id: input.invitationId },
        data: {
          rsvpYesCount: { increment: delta.yes },
          rsvpNoCount: { increment: delta.no },
          rsvpGuestCount: { increment: delta.guests },
        },
      });

      return { ok: true as const, rsvpId: row.id, created: previous === null };
    });
  }

  /**
   * Applies a guest's correction (D7.4).
   *
   * The token and the window are both **predicates in the statement**, not
   * checks in application code: a read-then-write would be a race, and a
   * hand-written token comparison invites a timing leak. Zero rows matched
   * means "wrong token, unknown response, or too late", and the caller
   * deliberately cannot tell which.
   */
  async edit(input: EditRsvpCommand): Promise<EditRsvpOutcome> {
    return this.prisma.$transaction(async (tx) => {
      // The response's own invitation is not known until it is read, so the
      // lock is taken in two steps: find the row, then lock the invitation and
      // re-read under it.
      const owner = await tx.rsvp.findFirst({
        where: { id: input.rsvpId },
        select: { invitationId: true },
      });
      if (!owner) return { ok: false as const, error: 'BAD_TOKEN' as const };
      await lockInvitation(tx, owner.invitationId);

      const existing = await tx.rsvp.findFirst({
        where: {
          id: input.rsvpId,
          editTokenHash: Buffer.from(input.editTokenHash),
        },
        select: {
          id: true,
          invitationId: true,
          attending: true,
          partySize: true,
          submittedAt: true,
        },
      });

      if (!existing) return { ok: false as const, error: 'BAD_TOKEN' as const };
      if (existing.submittedAt.getTime() < input.editableUntil.getTime()) {
        return { ok: false as const, error: 'WINDOW_CLOSED' as const };
      }

      const delta = counterDelta(
        { attending: existing.attending, partySize: existing.partySize },
        { attending: input.attending, partySize: input.partySize },
      );

      await tx.rsvp.update({
        where: { id: existing.id },
        data: {
          attending: input.attending,
          partySize: input.partySize,
          note: input.note,
          updatedAt: input.now,
        },
      });

      await tx.invitation.update({
        where: { id: existing.invitationId },
        data: {
          rsvpYesCount: { increment: delta.yes },
          rsvpNoCount: { increment: delta.no },
          rsvpGuestCount: { increment: delta.guests },
        },
      });

      return { ok: true as const, rsvpId: existing.id };
    });
  }

  // ── the owner's side ──────────────────────────────────────────────────────

  async listInScope(
    invitationId: string,
    scope: TenantScope,
    filter: RsvpListFilter,
  ): Promise<{ rows: readonly RsvpRecord[]; total: number }> {
    if (!(await this.reachable(invitationId, scope))) return { rows: [], total: 0 };

    const where: Prisma.RsvpWhereInput = {
      invitationId,
      ...(filter.attending === undefined ? {} : { attending: filter.attending }),
      ...(filter.query
        ? {
            OR: [
              { name: { contains: filter.query, mode: 'insensitive' } },
              { phone: { contains: filter.query } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.rsvp.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        take: filter.limit,
        skip: filter.offset,
      }),
      this.prisma.rsvp.count({ where }),
    ]);

    return { rows: rows.map(toRecord), total };
  }

  /**
   * The dashboard's headline numbers.
   *
   * Aggregated from the rows rather than read off the denormalised counters on
   * the invitation. The counters exist to be fast on the public page; this is
   * the couple's own list, where being *right* matters more than being fast,
   * and computing it independently is also what would surface a counter that
   * had drifted.
   */
  async statsInScope(invitationId: string, scope: TenantScope): Promise<RsvpStats | null> {
    if (!(await this.reachable(invitationId, scope))) return null;

    const [responses, attending, declined, guests] = await Promise.all([
      this.prisma.rsvp.count({ where: { invitationId } }),
      this.prisma.rsvp.count({ where: { invitationId, attending: true } }),
      this.prisma.rsvp.count({ where: { invitationId, attending: false } }),
      this.prisma.rsvp.aggregate({
        where: { invitationId, attending: true },
        _sum: { partySize: true },
      }),
    ]);

    return { responses, attending, declined, guests: guests._sum.partySize ?? 0 };
  }

  async allInScope(
    invitationId: string,
    scope: TenantScope,
    limit: number,
  ): Promise<readonly RsvpRecord[]> {
    if (!(await this.reachable(invitationId, scope))) return [];

    const rows = await this.prisma.rsvp.findMany({
      where: { invitationId },
      orderBy: { submittedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  /**
   * Removes a response and corrects the counters with it.
   *
   * A hard delete rather than a soft one: this is a guest's personal data that
   * the couple has decided to remove, and keeping a hidden copy would make the
   * deletion a lie.
   */
  async deleteInScope(
    rsvpId: string,
    invitationId: string,
    scope: TenantScope,
    _now: Date,
  ): Promise<boolean> {
    if (!(await this.reachable(invitationId, scope))) return false;

    return this.prisma.$transaction(async (tx) => {
      await lockInvitation(tx, invitationId);

      const existing = await tx.rsvp.findFirst({
        where: { id: rsvpId, invitationId },
        select: { id: true, attending: true, partySize: true },
      });
      if (!existing) return false;

      await tx.rsvp.delete({ where: { id: existing.id } });
      await tx.invitation.update({
        where: { id: invitationId },
        data: {
          rsvpYesCount: { increment: existing.attending ? -1 : 0 },
          rsvpNoCount: { increment: existing.attending ? 0 : -1 },
          rsvpGuestCount: { increment: existing.attending ? -existing.partySize : 0 },
        },
      });
      return true;
    });
  }
}

/**
 * Serialises every counter change for one invitation.
 *
 * The counters are a read-modify-write: read the previous answer, work out the
 * delta, apply it. Under PostgreSQL's default READ COMMITTED isolation, two
 * transactions replying for the *same guest* both read "no previous answer",
 * both decide `+1`, and both apply it — while the unique index quite correctly
 * collapses them into one row. One row, two increments: the guest list and the
 * counter disagree, and the couple caters from the wrong number.
 *
 * That is not hypothetical. It is exactly what M7's exit criterion — fifty
 * simultaneous replies with duplicates among them — produced before this lock
 * existed, on the second run rather than the first, which is how concurrency
 * defects usually arrive.
 *
 * Locking the invitation row is the right granularity because the counters
 * live on it: replies to *one* invitation serialise, and replies to different
 * weddings never contend. The transactions are short, and a wedding receives
 * hundreds of replies, not millions.
 *
 * `FOR NO KEY UPDATE` rather than `FOR UPDATE`: it takes a weaker lock that
 * still blocks concurrent writers of this row, without blocking foreign-key
 * references to it — a new reply inserting a row that points at this
 * invitation would otherwise contend for no reason.
 */
async function lockInvitation(tx: Prisma.TransactionClient, invitationId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM invitations WHERE id = ${invitationId}::uuid FOR NO KEY UPDATE`;
}

type RsvpRow = Awaited<ReturnType<PrismaClient['rsvp']['findFirstOrThrow']>>;

/**
 * Maps a row to a domain record.
 *
 * Explicit rather than a spread, and note what it leaves behind: `dedupeHash`
 * and `editTokenHash` never cross this boundary. They are credentials, and a
 * dashboard endpoint that returned them would let anyone who can read the list
 * edit every response on it.
 */
function toRecord(row: RsvpRow): RsvpRecord {
  return {
    id: row.id,
    invitationId: row.invitationId,
    name: row.name,
    attending: row.attending,
    partySize: row.partySize,
    phone: row.phone,
    note: row.note,
    source: row.source,
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt,
  };
}
