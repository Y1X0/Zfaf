import type { StorageKey } from '@zfaf/shared';

/**
 * Storage provider port (ADR-0007, amended at approval).
 *
 * R2 is the chosen implementation, but the application depends on this
 * interface so the choice stays reversible. MinIO speaks the same S3 API and is
 * used locally through the same adapter contract, which keeps the abstraction
 * honest rather than theoretical.
 */

export interface SignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  /** Headers the client must send; they are part of the signature. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface ObjectMetadata {
  readonly key: StorageKey;
  /** Actual byte length from storage — never the client's claim. */
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
}

export interface CreateUploadUrlInput {
  readonly key: StorageKey;
  /** Bound into the signature so the client cannot upload a different type. */
  readonly contentType: string;
  /** Bound into the signature so a 4 MB request cannot upload 5 GB. */
  readonly maxSizeBytes: number;
  readonly expiresInSeconds: number;
}

export interface StorageProvider {
  readonly key: string;

  createUploadUrl(input: CreateUploadUrlInput): Promise<SignedUpload>;

  /** Short-lived read URL for drafts and previews, which are not public. */
  createSignedDownloadUrl(key: StorageKey, ttlSeconds: number): Promise<string>;

  /** Source of truth for size and type after an upload completes. */
  head(key: StorageKey): Promise<ObjectMetadata | null>;

  delete(key: StorageKey): Promise<void>;

  /** Bulk removal for account and invitation deletion. Returns the count. */
  deletePrefix(prefix: string): Promise<number>;
}

/** Image types accepted for upload. */
export const ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  // The iPhone default. Rejecting it would turn away a large share of users.
  'image/heic',
  'image/heif',
];

/**
 * Types rejected outright, with the reason.
 *
 * SVG is XML and can carry a `<script>` element, which makes an uploaded image
 * a stored-XSS vector (docs/12-security-threat-model.md §3-I).
 */
export const REJECTED_TYPES: Readonly<Record<string, string>> = {
  'image/svg+xml': 'SVG can carry executable script',
  'image/tiff': 'Decoder attack surface with no user benefit',
  'text/html': 'Not an image',
  'application/octet-stream': 'Unidentified content',
};

export function isAllowedImageType(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(contentType.toLowerCase());
}

/**
 * Builds a storage key.
 *
 * The user's original filename never appears in the key: it is the classic path
 * traversal and encoding-injection vector, and it is kept in the database for
 * display only.
 */
export function buildMediaKey(input: {
  ownerId: string;
  invitationId: string | null;
  mediaId: string;
  variant: string;
  extension: string;
}): StorageKey {
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9-]/g, '');
  const scope = input.invitationId ? safe(input.invitationId) : 'library';
  return `media/${safe(input.ownerId)}/${scope}/${safe(input.mediaId)}/${safe(input.variant)}.${safe(input.extension)}` as StorageKey;
}
