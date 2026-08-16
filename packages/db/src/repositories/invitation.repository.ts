import type { PrismaClient, Prisma } from '@prisma/client';
import {
  type CreateInvitationInput,
  type InvitationRecord,
  type InvitationRepository,
  type InvitationStatus,
  type InvitationSummary,
  type PublicInvitationView,
  type PublishInput,
  type PublishOutcome,
  type TenantScope,
  type RollbackOutcome,
  type UpdateDraftOutcome,
  readSnapshot,
  snapshotChecksum,
} from '@zfaf/core';

/**
 * Prisma implementation of the invitation repository.
 *
 * The important property is that tenant scoping is applied *here*, inside the
 * query, rather than being expected of the caller. A route that forgets an
 * authorization check still cannot read another tenant's row, because there is
 * no code path that builds a query without the scope predicate.
 */
export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Turns a scope into a `WHERE` fragment.
   *
   * Staff see everything (and every such read is auditable); everyone else sees
   * what they own or are a member of. Nothing else can be expressed.
   */
  private scopeWhere(scope: TenantScope): Prisma.InvitationWhereInput {
    if (scope.isPlatformStaff) return {};

    const clauses: Prisma.InvitationWhereInput[] = [];
    if (scope.ownerId !== null) clauses.push({ ownerId: scope.ownerId });
    if (scope.invitationIds.length > 0) clauses.push({ id: { in: [...scope.invitationIds] } });

    // A scope that grants nothing must match nothing. Returning `{}` here would
    // silently widen it to every invitation — the exact failure this design
    // exists to prevent.
    if (clauses.length === 0) return { id: { in: [] } };
    return { OR: clauses };
  }

  async findByIdInScope(id: string, scope: TenantScope): Promise<InvitationRecord | null> {
    const row = await this.prisma.invitation.findFirst({
      where: { AND: [{ id }, { deletedAt: null }, this.scopeWhere(scope)] },
      // The pinned template travels with the record. It used to be filled with
      // empty placeholders, which meant any caller trusting `templateKey` was
      // silently reading `''` — a field that lies is worse than one that is
      // absent, because nothing fails until something depends on it.
      include: TEMPLATE_PIN,
    });
    return row ? toRecord(row) : null;
  }

  async listInScope(
    scope: TenantScope,
    filter?: { status?: InvitationStatus },
  ): Promise<readonly InvitationSummary[]> {
    const rows = await this.prisma.invitation.findMany({
      where: {
        AND: [
          { deletedAt: null },
          ...(filter?.status ? [{ status: filter.status }] : []),
          this.scopeWhere(scope),
        ],
      },
      select: { id: true, slug: true, title: true, status: true, eventDate: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status as InvitationStatus,
      eventDate: toDateString(row.eventDate),
      updatedAt: row.updatedAt,
    }));
  }

  async countActiveInScope(scope: TenantScope): Promise<number> {
    return this.prisma.invitation.count({
      where: {
        AND: [
          { deletedAt: null, status: { in: ['DRAFT', 'PUBLISHED', 'PAUSED'] } },
          this.scopeWhere(scope),
        ],
      },
    });
  }

  /**
   * The public read path.
   *
   * Takes no scope and returns a narrower type that structurally cannot carry
   * owner ids, draft content or counters. Adding a private field to
   * `InvitationRecord` later therefore cannot leak it through this method.
   */
  async findPublishedBySlug(slug: string): Promise<PublicInvitationView | null> {
    const row = await this.prisma.invitation.findFirst({
      where: { slug, deletedAt: null },
      select: {
        id: true,
        status: true,
        visibility: true,
        expiresAt: true,
        publishedVersionId: true,
      },
    });

    if (!row?.publishedVersionId) return null;

    const version = await this.prisma.invitationVersion.findUnique({
      where: { id: row.publishedVersionId },
      select: { publishedDocument: true, versionNumber: true },
    });
    if (!version) return null;

    // Re-validated rather than trusted: a snapshot written by an older schema,
    // or altered outside the application, must not render.
    const parsed = readSnapshot(version.publishedDocument);
    if (!parsed.ok) return null;

    return {
      invitationId: row.id,
      status: row.status as InvitationStatus,
      visibility: row.visibility,
      snapshot: parsed.snapshot,
      versionNumber: version.versionNumber,
      expiresAt: row.expiresAt,
    };
  }

  async findSlugRedirect(oldSlug: string): Promise<string | null> {
    const row = await this.prisma.slugHistory.findFirst({
      where: { oldSlug },
      select: { invitation: { select: { slug: true, deletedAt: true } } },
      orderBy: { changedAt: 'desc' },
    });
    if (!row?.invitation || row.invitation.deletedAt !== null) return null;
    return row.invitation.slug;
  }

  /**
   * Advisory availability check for the publish dialog.
   *
   * A retired slug counts as taken. Handing it to someone else would silently
   * repoint a link that is still in other people's messages at a stranger's
   * wedding — which is worse than the original owner losing the name.
   */
  async isSlugAvailable(slug: string): Promise<boolean> {
    const [live, retired] = await Promise.all([
      this.prisma.invitation.count({ where: { slug, deletedAt: null } }),
      this.prisma.slugHistory.count({ where: { oldSlug: slug } }),
    ]);
    return live === 0 && retired === 0;
  }

  async create(input: CreateInvitationInput): Promise<InvitationRecord> {
    const templateVersion = await this.prisma.templateVersion.findUniqueOrThrow({
      where: { id: input.templateVersionId },
      select: { id: true, templateId: true },
    });

    const row = await this.prisma.invitation.create({
      data: {
        id: input.id,
        ownerId: input.ownerId,
        title: input.title,
        status: 'DRAFT',
        templateId: templateVersion.templateId,
        templateVersionId: templateVersion.id,
        locale: input.locale,
        marketCode: input.marketCode,
        timezone: input.timezone,
        eventDate: new Date(`${input.eventDate}T00:00:00.000Z`),
        draftDocument: input.draftDocument as Prisma.InputJsonValue,
        draftVersion: 1,
        createdAt: input.now,
        updatedAt: input.now,
      },
      include: TEMPLATE_PIN,
    });

    // The owner is also a member, so authorization has one shape to reason
    // about rather than "owner, or else a membership row".
    await this.prisma.invitationMember.create({
      data: {
        id: crypto.randomUUID(),
        invitationId: row.id,
        userId: input.ownerId,
        role: 'owner',
        acceptedAt: input.now,
        createdAt: input.now,
      },
    });

    return toRecord(row);
  }

  /**
   * Optimistic-concurrency draft update.
   *
   * The version predicate lives in the `UPDATE` statement, so two concurrent
   * autosaves cannot both win: the second matches zero rows and is reported as
   * a conflict for the caller to merge.
   */
  async updateDraft(
    id: string,
    scope: TenantScope,
    draftDocument: unknown,
    expectedVersion: number,
    now: Date,
  ): Promise<UpdateDraftOutcome> {
    const existing = await this.findByIdInScope(id, scope);
    if (!existing) return { ok: false, error: 'NOT_FOUND' };

    const updated = await this.prisma.invitation.updateMany({
      where: { id, draftVersion: expectedVersion, deletedAt: null },
      data: {
        draftDocument: draftDocument as Prisma.InputJsonValue,
        draftVersion: { increment: 1 },
        updatedAt: now,
      },
    });

    if (updated.count === 0) {
      return { ok: false, error: 'VERSION_CONFLICT', currentVersion: existing.draftVersion };
    }
    return { ok: true, draftVersion: expectedVersion + 1 };
  }

  /**
   * Publishes atomically.
   *
   * Inserting the version and moving the pointer happen in one transaction, so
   * an invitation can never reference a snapshot that does not exist. Slug
   * uniqueness is left to the partial unique index rather than a prior read:
   * a check-then-write would let two simultaneous publishes both pass the check
   * (ADR-0013).
   */
  async publish(input: PublishInput, scope: TenantScope): Promise<PublishOutcome> {
    const invitation = await this.findByIdInScope(input.invitationId, scope);
    if (!invitation) return { ok: false, error: 'NOT_FOUND' };
    if (invitation.status === 'SUSPENDED' || invitation.status === 'DELETED') {
      return { ok: false, error: 'ILLEGAL_TRANSITION' };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const latest = await tx.invitationVersion.findFirst({
          where: { invitationId: input.invitationId },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true },
        });
        const versionNumber = (latest?.versionNumber ?? 0) + 1;
        const versionId = crypto.randomUUID();

        await tx.invitationVersion.create({
          data: {
            id: versionId,
            invitationId: input.invitationId,
            versionNumber,
            publishedDocument: input.snapshot as unknown as Prisma.InputJsonValue,
            documentChecksum: snapshotChecksum(input.snapshot),
            templateVersionId: invitation.templateVersionId,
            publishedById: input.publishedBy,
            publishedAt: input.now,
          },
        });

        // Renaming keeps the old slug resolvable: the previous link is already
        // in hundreds of WhatsApp threads and cannot be recalled (ADR-0013).
        if (invitation.slug !== null && invitation.slug !== input.slug) {
          await tx.slugHistory.create({
            data: {
              id: crypto.randomUUID(),
              invitationId: input.invitationId,
              oldSlug: invitation.slug,
              changedAt: input.now,
            },
          });
        }

        await tx.invitation.update({
          where: { id: input.invitationId },
          data: {
            slug: input.slug,
            status: 'PUBLISHED',
            publishedVersionId: versionId,
            publishedAt: invitation.publishedAt ?? input.now,
            expiresAt: input.expiresAt,
            updatedAt: input.now,
          },
        });

        return { ok: true as const, versionId, versionNumber };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, error: 'SLUG_TAKEN' };
      throw error;
    }
  }

  async transitionStatus(
    id: string,
    scope: TenantScope,
    next: InvitationStatus,
    now: Date,
  ): Promise<boolean> {
    const result = await this.prisma.invitation.updateMany({
      where: { AND: [{ id }, { deletedAt: null }, this.scopeWhere(scope)] },
      data: { status: next, updatedAt: now },
    });
    return result.count > 0;
  }

  /**
   * Moves the published pointer to an earlier version (D6.3).
   *
   * Only the pointer moves. The version being left is not deleted and the one
   * being returned to is not rewritten — the append-only trigger would refuse
   * either — so a rollback is itself reversible.
   */
  async rollbackToVersion(
    id: string,
    scope: TenantScope,
    versionNumber: number,
    now: Date,
  ): Promise<RollbackOutcome> {
    const invitation = await this.findByIdInScope(id, scope);
    if (!invitation) return { ok: false, error: 'NOT_FOUND' };
    if (invitation.publishedVersionId === null) return { ok: false, error: 'NOT_PUBLISHED' };

    const target = await this.prisma.invitationVersion.findFirst({
      where: { invitationId: id, versionNumber },
      select: { id: true, versionNumber: true },
    });
    if (!target) return { ok: false, error: 'NO_SUCH_VERSION' };

    await this.prisma.invitation.update({
      where: { id },
      // `publishedAt` is left alone: it records when this invitation first went
      // live, and rolling back does not change that it did.
      data: { publishedVersionId: target.id, updatedAt: now },
    });

    return { ok: true, versionId: target.id, versionNumber: target.versionNumber };
  }

  /**
   * The scheduled expiry sweep.
   *
   * Unscoped, and narrow enough that the missing scope leaks nothing: the
   * predicate names the two conditions in full, so the statement can only
   * touch invitations that are published and whose own expiry has passed.
   */
  async expireDueInvitations(now: Date, limit: number): Promise<readonly string[]> {
    const due = await this.prisma.invitation.findMany({
      where: { status: 'PUBLISHED', deletedAt: null, expiresAt: { not: null, lte: now } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    if (due.length === 0) return [];

    const ids = due.map((row) => row.id);
    // Re-stating the predicate rather than trusting the ids alone: an
    // invitation republished between the read and the write must not be
    // expired out from under its owner.
    const updated = await this.prisma.invitation.updateMany({
      where: { id: { in: ids }, status: 'PUBLISHED', expiresAt: { not: null, lte: now } },
      data: { status: 'EXPIRED', updatedAt: now },
    });

    return updated.count === ids.length ? ids : await this.confirmExpired(ids);
  }

  /** Which of the candidates actually ended up expired, when some raced. */
  private async confirmExpired(ids: readonly string[]): Promise<readonly string[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { id: { in: [...ids] }, status: 'EXPIRED' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async setVisibility(
    id: string,
    scope: TenantScope,
    visibility: 'UNLISTED' | 'INDEXED',
    now: Date,
  ): Promise<boolean> {
    // `PROTECTED` is not reachable from here: it needs a credential the MVP
    // does not collect, and offering the state without the mechanism would be
    // the security theatre ADR-0017 exists to prevent.
    const result = await this.prisma.invitation.updateMany({
      where: { AND: [{ id }, { deletedAt: null }, this.scopeWhere(scope)] },
      data: { visibility, updatedAt: now },
    });
    return result.count > 0;
  }

  async softDelete(id: string, scope: TenantScope, now: Date): Promise<boolean> {
    const result = await this.prisma.invitation.updateMany({
      where: { AND: [{ id }, { deletedAt: null }, this.scopeWhere(scope)] },
      // The slug is released on delete so the name becomes available again;
      // the partial unique index is what makes that safe.
      data: { status: 'DELETED', deletedAt: now, updatedAt: now, slug: null },
    });
    return result.count > 0;
  }

  async listVersions(
    id: string,
    scope: TenantScope,
  ): Promise<readonly { versionId: string; versionNumber: number; publishedAt: Date }[]> {
    const invitation = await this.findByIdInScope(id, scope);
    if (!invitation) return [];

    const rows = await this.prisma.invitationVersion.findMany({
      where: { invitationId: id },
      select: { id: true, versionNumber: true, publishedAt: true },
      orderBy: { versionNumber: 'desc' },
      take: 20,
    });
    return rows.map((row) => ({
      versionId: row.id,
      versionNumber: row.versionNumber,
      publishedAt: row.publishedAt,
    }));
  }

  async getVersionSnapshot(id: string, versionNumber: number, scope: TenantScope) {
    const invitation = await this.findByIdInScope(id, scope);
    if (!invitation) return null;

    const row = await this.prisma.invitationVersion.findFirst({
      where: { invitationId: id, versionNumber },
      select: { publishedDocument: true },
    });
    if (!row) return null;

    const parsed = readSnapshot(row.publishedDocument);
    return parsed.ok ? parsed.snapshot : null;
  }
}

// ── mapping ─────────────────────────────────────────────────────────────────

/**
 * The template an invitation is pinned to.
 *
 * Selected on every read that produces a record, because the snapshot written
 * at publish time freezes this pair and a caller must be able to see it
 * (ADR-0005).
 */
const TEMPLATE_PIN = {
  template: { select: { key: true } },
} as const;

type InvitationRow = Awaited<ReturnType<PrismaClient['invitation']['findFirstOrThrow']>> & {
  template?: { key: string };
};

/**
 * Maps a row to a domain record.
 *
 * Explicit rather than a spread, so a column added to the table does not
 * silently become part of the domain type — and so Prisma's generated types
 * never leak upward.
 */
function toRecord(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    slug: row.slug,
    title: row.title,
    status: row.status as InvitationStatus,
    templateKey: row.template?.key ?? '',
    templateVersionId: row.templateVersionId,
    locale: row.locale as 'ar' | 'en',
    marketCode: row.marketCode,
    timezone: row.timezone,
    eventDate: toDateString(row.eventDate),
    eventStartTime: row.eventStartTime,
    draftDocument: row.draftDocument,
    draftVersion: row.draftVersion,
    publishedVersionId: row.publishedVersionId,
    visibility: row.visibility,
    expiresAt: row.expiresAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
