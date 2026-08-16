import type { Prisma, PrismaClient } from '@prisma/client';
import type { StorageKey } from '@zfaf/shared';
import {
  type CreatePendingMediaInput,
  type MediaAssetRecord,
  type MediaMaintenanceRepository,
  type MediaProcessingRepository,
  type MediaRepository,
  type MediaStatus,
  type MediaUsage,
  type ScanStatus,
  type TenantScope,
  type UploadPurpose,
  countsTowardQuota,
  mediaIdsInSnapshotContent,
} from '@zfaf/core';

/**
 * Prisma implementations of the media ports.
 *
 * Three classes rather than one, matching the three ports, because they have
 * genuinely different authority:
 *
 *   • `PrismaMediaRepository` is request-scoped and every query carries a
 *     `TenantScope`, applied inside the query rather than expected of the
 *     caller (the M1 rule).
 *   • `PrismaMediaProcessingRepository` serves the worker, which acts on an id
 *     the application already authorised. It has no listing or searching
 *     method at all, so it cannot reach another owner's asset even in
 *     principle.
 *   • `PrismaMediaMaintenanceRepository` reads across owners by design — it is
 *     a sweep, not a request — and is limited to the two queries garbage
 *     collection needs.
 *
 * Splitting them is what stops the worker's broad access from becoming
 * reachable from a route handler.
 */

type MediaRow = Prisma.MediaAssetGetPayload<Record<string, never>>;

function toRecord(row: MediaRow): MediaAssetRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    invitationId: row.invitationId,
    purpose: row.purpose,
    storageKey: row.storageKey as StorageKey,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    // BigInt in the column because a byte count should never silently wrap;
    // Number here because every consumer compares it against a limit that
    // fits comfortably inside a double.
    sizeBytes: Number(row.sizeBytes),
    signedMaxBytes: Number(row.signedMaxBytes),
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    variants: (row.variants ?? {}) as Readonly<Record<string, unknown>>,
    status: row.status as MediaStatus,
    scanStatus: row.scanStatus as ScanStatus,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export class PrismaMediaRepository implements MediaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Turns a scope into a `WHERE` fragment. A scope granting nothing matches nothing. */
  private scopeWhere(scope: TenantScope): Prisma.MediaAssetWhereInput {
    if (scope.isPlatformStaff) return {};

    const clauses: Prisma.MediaAssetWhereInput[] = [];
    if (scope.ownerId !== null) clauses.push({ ownerId: scope.ownerId });
    if (scope.invitationIds.length > 0) {
      clauses.push({ invitationId: { in: [...scope.invitationIds] } });
    }
    if (clauses.length === 0) return { id: { in: [] } };
    return { OR: clauses };
  }

  async create(scope: TenantScope, input: CreatePendingMediaInput): Promise<MediaAssetRecord> {
    // The scope is not a filter on an insert, but the owner it authorises must
    // match the owner being written — otherwise a request could create a row
    // belonging to somebody else.
    if (!scope.isPlatformStaff && scope.ownerId !== null && scope.ownerId !== input.ownerId) {
      throw new Error('Refusing to create media for an owner outside the request scope');
    }

    const row = await this.prisma.mediaAsset.create({
      data: {
        id: input.id,
        ownerId: input.ownerId,
        invitationId: input.invitationId,
        kind: 'image',
        purpose: input.purpose,
        storageKey: input.storageKey,
        originalFilename: input.originalFilename,
        // The client's claim. Replaced by the sniffed type once the worker has
        // looked at the bytes.
        mimeType: input.declaredMimeType,
        sizeBytes: BigInt(input.declaredSizeBytes),
        signedMaxBytes: BigInt(input.signedMaxBytes),
        status: 'pending',
        scanStatus: 'pending',
      },
    });

    return toRecord(row);
  }

  async findById(scope: TenantScope, mediaId: string): Promise<MediaAssetRecord | null> {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { AND: [{ id: mediaId }, this.scopeWhere(scope)] },
    });
    return row ? toRecord(row) : null;
  }

  async storageUsedBytes(scope: TenantScope): Promise<number> {
    const rows = await this.prisma.mediaAsset.findMany({
      where: { AND: [{ deletedAt: null }, this.scopeWhere(scope)] },
      select: { sizeBytes: true, status: true },
    });

    // `pending` counts, because the bytes may already be in the bucket. Not
    // counting them is how an owner exceeds their quota by never confirming.
    return rows
      .filter((row) => countsTowardQuota(row.status as MediaStatus))
      .reduce((total, row) => total + Number(row.sizeBytes), 0);
  }

  async countByPurpose(
    scope: TenantScope,
    invitationId: string | null,
    purpose: UploadPurpose,
  ): Promise<number> {
    return this.prisma.mediaAsset.count({
      where: {
        AND: [
          { purpose, invitationId, deletedAt: null },
          { status: { not: 'failed' } },
          this.scopeWhere(scope),
        ],
      },
    });
  }

  /**
   * Where an asset is referenced (D4.7).
   *
   * The published side is what blocks deletion, so it is answered from
   * `invitation_versions` rows that are currently published rather than from
   * any denormalised counter — a counter that drifts would either block a
   * legitimate delete or, far worse, allow one that breaks a live invitation.
   */
  async usage(scope: TenantScope, mediaId: string): Promise<MediaUsage> {
    const media = await this.findById(scope, mediaId);
    if (!media) return { publishedVersionIds: [], draftReferenceCount: 0 };

    // Filtered on `status`, not merely on the presence of a version row. An
    // unpublished invitation keeps its last version — that is how republishing
    // works — but no guest can open it, so its images must become deletable
    // again. Checking only `publishedVersionId` would leave an owner
    // permanently unable to tidy a library after unpublishing.
    const invitations = await this.prisma.invitation.findMany({
      where: {
        status: 'PUBLISHED',
        publishedVersionId: { not: null },
        deletedAt: null,
        ownerId: media.ownerId,
      },
      select: { publishedVersionId: true },
    });

    const versionIds = invitations
      .map((invitation) => invitation.publishedVersionId)
      .filter((id): id is string => id !== null);

    if (versionIds.length === 0) return { publishedVersionIds: [], draftReferenceCount: 0 };

    const versions = await this.prisma.invitationVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, publishedDocument: true },
    });

    const publishedVersionIds = versions
      .filter((version) => {
        const snapshot = version.publishedDocument as { content?: unknown } | null;
        return mediaIdsInSnapshotContent(snapshot?.content).includes(mediaId);
      })
      .map((version) => version.id);

    return { publishedVersionIds, draftReferenceCount: 0 };
  }

  async markStatus(scope: TenantScope, mediaId: string, status: MediaStatus): Promise<void> {
    await this.prisma.mediaAsset.updateMany({
      where: { AND: [{ id: mediaId }, this.scopeWhere(scope)] },
      data: { status },
    });
  }

  async softDelete(scope: TenantScope, mediaId: string, deletedAt: Date): Promise<void> {
    await this.prisma.mediaAsset.updateMany({
      where: { AND: [{ id: mediaId }, this.scopeWhere(scope)] },
      data: { deletedAt },
    });
  }
}

/**
 * The worker's narrow view.
 *
 * Four operations, all keyed by a single media id. There is deliberately no
 * way to list, search or filter, so the background process cannot become a
 * route to cross-tenant reads.
 */
export class PrismaMediaProcessingRepository implements MediaProcessingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async loadForProcessing(mediaId: string): Promise<MediaAssetRecord | null> {
    const row = await this.prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    return row ? toRecord(row) : null;
  }

  async markProcessing(mediaId: string): Promise<void> {
    await this.prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { status: 'processing' },
    });
  }

  async completeProcessing(input: {
    mediaId: string;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
    blurhash: string;
    variants: Readonly<Record<string, unknown>>;
    scanStatus: ScanStatus;
  }): Promise<void> {
    await this.prisma.mediaAsset.update({
      where: { id: input.mediaId },
      data: {
        // Replaces the client's claim with what the bytes turned out to be.
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        width: input.width,
        height: input.height,
        blurhash: input.blurhash,
        variants: input.variants as Prisma.InputJsonValue,
        status: 'ready',
        scanStatus: input.scanStatus,
      },
    });
  }

  async markFailed(mediaId: string, reason: string): Promise<void> {
    await this.prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { status: 'failed', variants: { failure: reason } as Prisma.InputJsonValue },
    });
  }

  /** Terminal. Nothing in this class moves an asset back out of quarantine. */
  async quarantine(mediaId: string, reason: string): Promise<void> {
    await this.prisma.mediaAsset.update({
      where: { id: mediaId },
      data: {
        status: 'quarantined',
        scanStatus: 'infected',
        variants: { quarantineReason: reason } as Prisma.InputJsonValue,
      },
    });
  }
}

export class PrismaMediaMaintenanceRepository implements MediaMaintenanceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findStalePendingUploads(
    olderThan: Date,
    limit: number,
  ): Promise<readonly MediaAssetRecord[]> {
    const rows = await this.prisma.mediaAsset.findMany({
      where: { status: 'pending', createdAt: { lt: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findPurgeableAssets(
    deletedBefore: Date,
    limit: number,
  ): Promise<readonly MediaAssetRecord[]> {
    const rows = await this.prisma.mediaAsset.findMany({
      where: { deletedAt: { not: null, lt: deletedBefore } },
      orderBy: { deletedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async hardDelete(mediaId: string): Promise<void> {
    await this.prisma.mediaAsset.delete({ where: { id: mediaId } });
  }
}
