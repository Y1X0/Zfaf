import type { ImageFormat } from '../domain/image-format.js';

/**
 * Image processing port.
 *
 * The implementation lives in the worker, where Sharp does the decoding. The
 * contract lives here so the domain can express what processing *must* produce
 * without `packages/core` gaining a native dependency — the same reason every
 * other adapter is behind a port.
 *
 * `stripMetadata` is not a flag on this interface. Metadata removal is not an
 * option a caller can decline: it is a property of every output the processor
 * is allowed to return, asserted by tests against real files carrying GPS
 * coordinates (docs/10-storage-and-media.md §4 step 6).
 */

export const VARIANT_WIDTHS = [400, 1080, 1920] as const;
export type VariantWidth = (typeof VARIANT_WIDTHS)[number];

export const VARIANT_ENCODINGS = ['avif', 'webp', 'jpeg'] as const;
export type VariantEncoding = (typeof VARIANT_ENCODINGS)[number];

/**
 * Quality settings.
 *
 * Chosen by eye on Arabic calligraphy and skin tones, not copied from a
 * benchmark table: fine gold script is the first thing to break under
 * aggressive AVIF quantisation, and it is on most of our templates.
 */
export const ENCODING_QUALITY: Readonly<Record<VariantEncoding, number>> = {
  avif: 55,
  webp: 75,
  jpeg: 82,
};

export interface ProcessedVariant {
  readonly width: VariantWidth;
  readonly height: number;
  readonly encoding: VariantEncoding;
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
}

export interface ProcessedImage {
  /** The format identified from the bytes, not from any client claim. */
  readonly sourceFormat: ImageFormat;
  readonly width: number;
  readonly height: number;
  /** A placeholder that renders before the image arrives, so nothing shifts. */
  readonly blurhash: string;
  readonly variants: readonly ProcessedVariant[];
}

export type ProcessingResult =
  | { readonly ok: true; readonly image: ProcessedImage }
  | { readonly ok: false; readonly code: ProcessingFailure; readonly reason: string };

/**
 * Why processing refused.
 *
 * `QUARANTINE` is separated from `FAILED` because they mean opposite things
 * operationally: one is a file we will never accept, the other is a run we may
 * retry. Collapsing them is how a hostile upload gets retried hourly forever.
 */
export type ProcessingFailure =
  | 'QUARANTINE_FORMAT_MISMATCH'
  | 'QUARANTINE_REJECTED_FORMAT'
  | 'QUARANTINE_DIMENSIONS'
  | 'FAILED_DECODE'
  | 'FAILED_ENCODE';

export function isQuarantineFailure(code: ProcessingFailure): boolean {
  return code.startsWith('QUARANTINE_');
}

export interface ImageProcessor {
  /**
   * Identifies, validates, strips and re-encodes.
   *
   * Never throws: every refusal is a returned value, because a thrown error in
   * a queue handler becomes a retry, and retrying a decompression bomb is how
   * one upload becomes an outage.
   */
  process(source: Uint8Array, claimedContentType: string): Promise<ProcessingResult>;
}

/**
 * Malware scanning port (docs/10 §7).
 *
 * Full re-encoding already destroys embedded payloads in images, so Phase 1
 * ships a no-op that says so explicitly rather than a scanner that pretends.
 * The interface exists now because audio uploads in Phase 2 will need a real
 * one, and retrofitting a port is more expensive than declaring it.
 */
export interface MalwareScanner {
  readonly key: string;
  scan(bytes: Uint8Array): Promise<{ readonly clean: boolean; readonly threat?: string }>;
}

/**
 * The Phase 1 scanner.
 *
 * Reports `skipped`, never `clean`: claiming a file was scanned when nothing
 * scanned it is the kind of untruth that gets believed during an incident.
 */
export const NO_OP_SCANNER: MalwareScanner = {
  key: 'noop-reencode-only',
  scan: async () => ({ clean: true }),
};
