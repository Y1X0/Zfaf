import type { StorageKey } from '@zfaf/shared';

import type { Actor } from '../../authz/actor.js';
import { can } from '../../authz/can.js';
import { tenantScopeFor } from '../../authz/tenant-scope.js';
import type { Entitlements } from '../../billing/domain/entitlements.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { RateLimiter } from '../../identity/ports/rate-limiter.js';
import { buildMediaKey } from '../ports/storage-provider.js';
import type { SignedUpload, StorageProvider } from '../ports/storage-provider.js';
import type { MediaRepository } from '../ports/media-repository.js';
import { sanitiseOriginalFilename } from '../domain/original-filename.js';
import {
  UPLOAD_URL_TTL_SECONDS,
  type UploadPurpose,
  decideUpload,
  verifyActualSize,
} from '../domain/upload-policy.js';
import { transitionMedia } from '../domain/media-status.js';

/**
 * The three-stage upload (D4.2, docs/10-storage-and-media.md §4).
 *
 *   ① `requestUploadUrl` — authorise, check quota, sign a narrow URL
 *   ② the browser `PUT`s straight to storage — **our servers never see bytes**
 *   ③ `completeUpload`   — `HEAD` storage for the truth, then queue processing
 *
 * Stage ② is the whole point of the shape. A 20 MB photo that transits our
 * application server costs request time, memory and bandwidth for nothing:
 * the object store is better at receiving files than we will ever be.
 *
 * The cost of that design is that between ① and ③ we know nothing about the
 * object. So stage ③ trusts storage and nothing else — not the client's
 * reported size, not its content type, not even that the upload happened.
 */

export interface RequestUploadInput {
  readonly actor: Actor;
  readonly invitationId: string | null;
  /** For the authorization check; the caller loads it, we never infer it. */
  readonly invitationOwnerId: string | null;
  readonly purpose: UploadPurpose;
  readonly filename: string;
  readonly contentType: string;
  readonly declaredSizeBytes: number;
  readonly ipHash: string;
}

export interface RequestUploadDeps {
  readonly repository: MediaRepository;
  readonly storage: StorageProvider;
  readonly entitlements: Entitlements;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly rateLimiter: RateLimiter;
}

export type RequestUploadResult =
  | {
      readonly ok: true;
      readonly mediaId: string;
      readonly storageKey: StorageKey;
      readonly upload: SignedUpload;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Sixty uploads an hour is generous for a wedding and useless for a bot. */
export const UPLOAD_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const;

export async function requestUploadUrl(
  input: RequestUploadInput,
  deps: RequestUploadDeps,
): Promise<RequestUploadResult> {
  // Authorization first, and through the one decision point (M1/M2). A media
  // upload is an invitation edit, so it answers to the same membership rules.
  const decision = can(input.actor, 'media:upload', {
    kind: 'invitation',
    id: input.invitationId ?? '',
    ownerId: input.invitationOwnerId ?? '',
  });
  if (!decision.allowed) {
    return { ok: false, code: decision.reason, message: 'Not permitted to upload here' };
  }

  const scope = tenantScopeFor(input.actor);
  if (!scope) {
    return { ok: false, code: 'NO_TENANT_SCOPE', message: 'Not permitted to upload here' };
  }

  const now = deps.clock.now();
  const verdict = await deps.rateLimiter.consume(
    `media:upload:${input.ipHash}`,
    UPLOAD_RATE_LIMIT.limit,
    UPLOAD_RATE_LIMIT.windowMs,
    now,
  );
  if (!verdict.allowed) {
    return { ok: false, code: 'RATE_LIMITED', message: 'Too many uploads. Try again shortly.' };
  }

  const [storageUsedBytes, galleryImageCount] = await Promise.all([
    deps.repository.storageUsedBytes(scope),
    deps.repository.countByPurpose(scope, input.invitationId, 'gallery'),
  ]);

  const policy = decideUpload(
    {
      purpose: input.purpose,
      contentType: input.contentType,
      declaredSizeBytes: input.declaredSizeBytes,
    },
    { entitlements: deps.entitlements, storageUsedBytes, galleryImageCount },
  );
  if (!policy.allowed) {
    return { ok: false, code: policy.code, message: policy.message };
  }

  const mediaId = deps.ids.uuid();
  // The key is composed from server-side identifiers only. The user's filename
  // is kept for display and never appears here (docs/10 §3).
  const storageKey = buildMediaKey({
    ownerId: input.actor.kind === 'user' ? input.actor.userId : '',
    invitationId: input.invitationId,
    mediaId,
    variant: 'original',
    extension: 'bin',
  });

  const upload = await deps.storage.createUploadUrl({
    key: storageKey,
    // Both are bound into the signature. Without the size bound a URL issued
    // for a 4 MB photo accepts a 5 GB object (docs/10 §4 ①).
    contentType: input.contentType,
    maxSizeBytes: policy.maxSizeBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });

  await deps.repository.create(scope, {
    id: mediaId,
    ownerId: input.actor.kind === 'user' ? input.actor.userId : '',
    invitationId: input.invitationId,
    purpose: input.purpose,
    storageKey,
    originalFilename: sanitiseOriginalFilename(input.filename),
    declaredMimeType: input.contentType,
    declaredSizeBytes: input.declaredSizeBytes,
    signedMaxBytes: policy.maxSizeBytes,
  });

  return { ok: true, mediaId, storageKey, upload };
}

// ── stage ③ ────────────────────────────────────────────────────────────────

export interface CompleteUploadInput {
  readonly actor: Actor;
  readonly mediaId: string;
  readonly invitationOwnerId: string | null;
}

export interface CompleteUploadDeps {
  readonly repository: MediaRepository;
  readonly storage: StorageProvider;
  readonly enqueue: (job: { readonly mediaId: string }) => Promise<void>;
}

export type CompleteUploadResult =
  | { readonly ok: true; readonly mediaId: string; readonly sizeBytes: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Confirms an upload.
 *
 * Everything recorded here comes from `HEAD` on the object store. The client
 * is not asked how large the file is or what type it is, because it has no way
 * to prove either and every answer it could give is one an attacker chooses.
 */
export async function completeUpload(
  input: CompleteUploadInput,
  deps: CompleteUploadDeps,
): Promise<CompleteUploadResult> {
  const scope = tenantScopeFor(input.actor);
  if (!scope) {
    return { ok: false, code: 'NO_TENANT_SCOPE', message: 'Not permitted' };
  }

  const media = await deps.repository.findById(scope, input.mediaId);
  if (!media) {
    // Indistinguishable from "not yours": a different message here would turn
    // this endpoint into an existence oracle for other owners' media ids.
    return { ok: false, code: 'NOT_FOUND', message: 'Media not found' };
  }

  const decision = can(input.actor, 'media:upload', {
    kind: 'invitation',
    id: media.invitationId ?? '',
    ownerId: input.invitationOwnerId ?? media.ownerId,
  });
  if (!decision.allowed) {
    return { ok: false, code: decision.reason, message: 'Not permitted' };
  }

  const transition = transitionMedia(media.status, 'processing');
  if (!transition.ok) {
    return { ok: false, code: 'INVALID_STATE', message: transition.reason };
  }

  const metadata = await deps.storage.head(media.storageKey);
  if (!metadata) {
    return {
      ok: false,
      code: 'OBJECT_MISSING',
      message: 'The upload did not reach storage. Please try again.',
    };
  }

  const sizeCheck = verifyActualSize(metadata.sizeBytes, media.signedMaxBytes);
  if (!sizeCheck.ok) {
    // The signature should have prevented this. Reaching it means a provider
    // did not honour the bound, so the object is quarantined rather than
    // processed — and the discrepancy is preserved for investigation.
    await deps.repository.markStatus(scope, media.id, 'quarantined');
    return { ok: false, code: 'SIZE_MISMATCH', message: sizeCheck.reason };
  }

  await deps.repository.markStatus(scope, media.id, 'processing');
  // Queued only after the row says `processing`: a job that arrives first
  // would find a `pending` row and refuse its own work.
  await deps.enqueue({ mediaId: media.id });

  return { ok: true, mediaId: media.id, sizeBytes: metadata.sizeBytes };
}
