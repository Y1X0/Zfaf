import type { Entitlements } from '../../billing/domain/entitlements.js';
import { UNLIMITED } from '../../billing/domain/entitlements.js';

/**
 * What a given user may upload right now.
 *
 * Every limit is read through `Entitlements` (ADR-0014) rather than compared
 * against a plan name, so adding a plan is a row rather than a code change.
 * The checks live here, in the domain, because they must produce the same
 * answer whether they are called before signing an upload URL or re-checked
 * after the object lands.
 *
 * Ordering is deliberate: the cheapest and most explicable failure is reported
 * first. A user who is both over quota and uploading an unsupported file
 * should be told about the file, which they can fix.
 */

export const UPLOAD_PURPOSES = ['cover', 'couple', 'gallery', 'ornament'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** How long a signed upload URL stays valid (docs/10 §4). */
export const UPLOAD_URL_TTL_SECONDS = 900;

/**
 * The ceiling no plan may exceed.
 *
 * Entitlements decide the per-plan limit; this is the absolute bound that
 * protects the processing pipeline regardless of what a plan row says.
 */
export const ABSOLUTE_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadRequest {
  readonly purpose: UploadPurpose;
  readonly contentType: string;
  /** The client's claim. Used only to fail early — never trusted afterwards. */
  readonly declaredSizeBytes: number;
}

export interface UploadContext {
  readonly entitlements: Entitlements;
  /** Bytes already stored by this owner, from the database. */
  readonly storageUsedBytes: number;
  /** Gallery images already attached to the target invitation. */
  readonly galleryImageCount: number;
}

export type UploadDecision =
  | { readonly allowed: true; readonly maxSizeBytes: number }
  | { readonly allowed: false; readonly code: UploadRefusal; readonly message: string };

export type UploadRefusal =
  | 'UNSUPPORTED_TYPE'
  | 'FILE_TOO_LARGE'
  | 'GALLERY_LIMIT_REACHED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'INVALID_SIZE';

/** Content types a client may request an upload URL for, by purpose. */
const ACCEPTED_REQUEST_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
];

function megabytesToBytes(megabytes: number): number {
  return megabytes === UNLIMITED ? UNLIMITED : megabytes * 1024 * 1024;
}

/**
 * The per-upload size ceiling for this user.
 *
 * Exported because the same number is bound into the signature *and* shown in
 * the interface; computing it twice is how the two drift apart.
 */
export function maxUploadBytesFor(entitlements: Entitlements): number {
  const fromPlan = megabytesToBytes(entitlements.limit('media.image_size_mb'));
  // A plan granting "unlimited" still cannot exceed what the worker can decode.
  return Math.min(fromPlan, ABSOLUTE_MAX_UPLOAD_BYTES);
}

export function decideUpload(request: UploadRequest, context: UploadContext): UploadDecision {
  const normalisedType = request.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!ACCEPTED_REQUEST_TYPES.includes(normalisedType)) {
    return {
      allowed: false,
      code: 'UNSUPPORTED_TYPE',
      message: `"${request.contentType}" is not an image type we accept`,
    };
  }

  if (
    !Number.isInteger(request.declaredSizeBytes) ||
    request.declaredSizeBytes <= 0 ||
    !Number.isFinite(request.declaredSizeBytes)
  ) {
    return { allowed: false, code: 'INVALID_SIZE', message: 'Declared size is not a byte count' };
  }

  const maxSizeBytes = maxUploadBytesFor(context.entitlements);
  if (request.declaredSizeBytes > maxSizeBytes) {
    return {
      allowed: false,
      code: 'FILE_TOO_LARGE',
      message: `File exceeds the ${Math.floor(maxSizeBytes / (1024 * 1024))} MB limit for this plan`,
    };
  }

  if (request.purpose === 'gallery') {
    const galleryLimit = context.entitlements.limit('media.gallery_images');
    if (context.galleryImageCount >= galleryLimit) {
      return {
        allowed: false,
        code: 'GALLERY_LIMIT_REACHED',
        message: `This plan allows ${galleryLimit} gallery images`,
      };
    }
  }

  const quotaBytes = megabytesToBytes(context.entitlements.limit('media.storage_mb'));
  if (context.storageUsedBytes + request.declaredSizeBytes > quotaBytes) {
    return {
      allowed: false,
      code: 'STORAGE_QUOTA_EXCEEDED',
      message: 'This upload would exceed the storage included in this plan',
    };
  }

  return { allowed: true, maxSizeBytes };
}

/**
 * Re-checks the size once storage reports the truth.
 *
 * The signature already bounds `Content-Length`, so this should never fire —
 * which is exactly why it is here. A provider that does not enforce the bound,
 * or a signature built wrongly, would otherwise be invisible until a 5 GB
 * object appeared in a bucket (docs/10 §4 stage ③).
 */
export function verifyActualSize(
  actualSizeBytes: number,
  signedMaxBytes: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!Number.isFinite(actualSizeBytes) || actualSizeBytes <= 0) {
    return { ok: false, reason: 'Storage reports no usable object size' };
  }
  if (actualSizeBytes > signedMaxBytes) {
    return {
      ok: false,
      reason: `Stored object is ${actualSizeBytes} bytes, above the signed limit of ${signedMaxBytes}`,
    };
  }
  return { ok: true };
}
