/**
 * The life of a media asset.
 *
 * Written as an explicit transition table for the same reason invitation
 * status is (M1): the illegal transitions are the interesting ones, and a
 * table states them where scattered `if` checks only imply them.
 *
 * The one that matters most: **nothing leaves `quarantined`.** A file that
 * failed magic-byte identification is not retried, not "reviewed and
 * released" by a background job, and not resurrected by a status update. If a
 * human decides it was a false positive, they create a new upload.
 */

export const MEDIA_STATUSES = ['pending', 'processing', 'ready', 'failed', 'quarantined'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'skipped'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

const TRANSITIONS: Readonly<Record<MediaStatus, readonly MediaStatus[]>> = {
  // The row exists but the bytes may never arrive; the sweep expires it.
  pending: ['processing', 'failed', 'quarantined'],
  processing: ['ready', 'failed', 'quarantined'],
  // A processed asset can still be quarantined if a later scan finds something.
  ready: ['quarantined'],
  // A transient failure — a worker restart, a timeout — may be retried.
  failed: ['processing', 'quarantined'],
  quarantined: [],
};

export function canTransitionMedia(from: MediaStatus, to: MediaStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { readonly ok: true; readonly status: MediaStatus }
  | { readonly ok: false; readonly reason: string };

export function transitionMedia(from: MediaStatus, to: MediaStatus): TransitionResult {
  if (from === to) {
    // Idempotent, not an error: a retried job must not fail on its own success.
    return { ok: true, status: to };
  }
  if (!canTransitionMedia(from, to)) {
    return { ok: false, reason: `A media asset cannot go from "${from}" to "${to}"` };
  }
  return { ok: true, status: to };
}

/** Statuses whose stored bytes count against the owner's quota. */
export function countsTowardQuota(status: MediaStatus): boolean {
  // `pending` counts: the bytes may already be in the bucket even though the
  // row is not confirmed. Excluding it is how an owner uploads past their
  // quota by never calling `complete`.
  return status !== 'failed';
}

/** Only a fully processed, scanned asset may be shown to a guest. */
export function isServable(status: MediaStatus, scanStatus: ScanStatus): boolean {
  return status === 'ready' && (scanStatus === 'clean' || scanStatus === 'skipped');
}

/**
 * Uploads abandoned before confirmation.
 *
 * A browser tab closed mid-upload leaves a row that will never complete. It is
 * swept rather than kept, but only after long enough that a slow upload on a
 * poor connection is not mistaken for an abandoned one.
 */
export const PENDING_UPLOAD_EXPIRY_HOURS = 24;

/**
 * How long an asset may sit in `processing` before it is presumed abandoned.
 *
 * Fifteen minutes, and the number comes from what it has to survive rather
 * than from taste: the slowest measured encode of a 12-megapixel photograph is
 * about a second of CPU, which on the smallest instance we deploy to is on the
 * order of ten seconds of wall clock. Anything still `processing` after
 * fifteen minutes is not slow, it is orphaned — a worker that died, or an
 * `inline` request whose process was replaced mid-encode (ADR-0023).
 *
 * Long enough that a redrive never races a run that is merely slow; short
 * enough that a customer's photograph is not lost for an afternoon.
 */
export const STUCK_PROCESSING_MINUTES = 15;

export function isStalePendingUpload(status: MediaStatus, createdAt: Date, now: Date): boolean {
  if (status !== 'pending') return false;
  const ageHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
  return ageHours >= PENDING_UPLOAD_EXPIRY_HOURS;
}

/**
 * How long a soft-deleted asset waits before its bytes are removed.
 *
 * The delay is the recovery window for "I deleted the wrong photo", which is
 * a far more common event than a storage bill mattering (docs/10 §9).
 */
export const SOFT_DELETE_GRACE_DAYS = 7;

export function isPurgeable(deletedAt: Date | null, now: Date): boolean {
  if (!deletedAt) return false;
  const ageDays = (now.getTime() - deletedAt.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays >= SOFT_DELETE_GRACE_DAYS;
}
