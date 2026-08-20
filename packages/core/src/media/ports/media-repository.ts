import type { StorageKey } from '@zfaf/shared';

import type { TenantScope } from '../../authz/tenant-scope.js';
import type { MediaStatus, ScanStatus } from '../domain/media-status.js';
import type { UploadPurpose } from '../domain/upload-policy.js';
import type { MediaUsage } from '../domain/media-deletion.js';

/**
 * Media persistence ports.
 *
 * Every read that returns a caller's own data takes a `TenantScope`, the same
 * rule M1 established: there is no `findById(id)` that could return another
 * owner's row because a handler forgot a `where` clause.
 *
 * The worker's port is separate and deliberately narrower. A background job
 * acts on a media id it was handed by the queue and has no user session to
 * scope by, so it gets exactly the four operations it needs and no way to
 * enumerate.
 */

export interface MediaAssetRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly invitationId: string | null;
  readonly purpose: string;
  readonly storageKey: StorageKey;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /**
   * The ceiling bound into the upload signature.
   *
   * Stored rather than recomputed at completion: entitlements can change in
   * the fifteen minutes a URL is valid, and a plan downgrade must not
   * retroactively quarantine a file that was legitimate when it was signed.
   */
  readonly signedMaxBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly blurhash: string | null;
  readonly variants: Readonly<Record<string, unknown>>;
  readonly status: MediaStatus;
  readonly scanStatus: ScanStatus;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export interface CreatePendingMediaInput {
  readonly id: string;
  readonly ownerId: string;
  readonly invitationId: string | null;
  readonly purpose: UploadPurpose;
  readonly storageKey: StorageKey;
  readonly originalFilename: string;
  /** The client's claim, recorded so a later mismatch is visible in audit. */
  readonly declaredMimeType: string;
  readonly declaredSizeBytes: number;
  /** Bound into the signature; re-checked against storage on completion. */
  readonly signedMaxBytes: number;
}

export interface MediaRepository {
  create(scope: TenantScope, input: CreatePendingMediaInput): Promise<MediaAssetRecord>;

  findById(scope: TenantScope, mediaId: string): Promise<MediaAssetRecord | null>;

  /** Bytes already stored by this owner, used for the quota check. */
  storageUsedBytes(scope: TenantScope): Promise<number>;

  countByPurpose(
    scope: TenantScope,
    invitationId: string | null,
    purpose: UploadPurpose,
  ): Promise<number>;

  /** Where an asset is referenced, so deletion can refuse (D4.7). */
  usage(scope: TenantScope, mediaId: string): Promise<MediaUsage>;

  markStatus(scope: TenantScope, mediaId: string, status: MediaStatus): Promise<void>;

  softDelete(scope: TenantScope, mediaId: string, deletedAt: Date): Promise<void>;

  /** Mark all media attached to an invitation as orphaned (invitation deleted). */
  orphanByInvitation(invitationId: string, orphanedAt: Date): Promise<void>;
}

/**
 * What the worker may do.
 *
 * No `TenantScope`: the job carries an id the application already authorised.
 * The narrowness is the safeguard — this port cannot list, search, or read
 * another owner's asset by construction.
 */
export interface MediaProcessingRepository {
  loadForProcessing(mediaId: string): Promise<MediaAssetRecord | null>;

  markProcessing(mediaId: string): Promise<void>;

  completeProcessing(input: {
    readonly mediaId: string;
    /** The type identified from bytes, replacing whatever the client claimed. */
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly width: number;
    readonly height: number;
    readonly blurhash: string;
    readonly variants: Readonly<Record<string, unknown>>;
    readonly scanStatus: ScanStatus;
  }): Promise<void>;

  markFailed(mediaId: string, reason: string): Promise<void>;

  /** Terminal. Nothing moves an asset back out of quarantine. */
  quarantine(mediaId: string, reason: string): Promise<void>;
}

/**
 * The sweep's port (D4.8).
 *
 * Reads across owners by design — it is a maintenance job, not a request — so
 * it is kept to the two queries garbage collection needs and is never reachable
 * from a request handler.
 */
export interface MediaMaintenanceRepository {
  /** Uploads confirmed by nobody, older than the expiry window. */
  findStalePendingUploads(olderThan: Date, limit: number): Promise<readonly MediaAssetRecord[]>;

  /** Soft-deleted assets past the recovery window. */
  findPurgeableAssets(deletedBefore: Date, limit: number): Promise<readonly MediaAssetRecord[]>;

  /** Media orphaned from deleted invitations older than the grace period. */
  findOrphanedMedia(orphanedBefore: Date, limit: number): Promise<readonly MediaAssetRecord[]>;

  /**
   * Assets left in `processing` by a run that never finished (ADR-0023).
   *
   * Filtered on `updatedAt` rather than `createdAt`: an asset that was
   * redriven once and stalled again must become eligible again, and its
   * creation time never moves.
   */
  findStuckProcessing(updatedBefore: Date, limit: number): Promise<readonly MediaAssetRecord[]>;

  /** Removes the row once its bytes are gone. */
  hardDelete(mediaId: string): Promise<void>;
}
