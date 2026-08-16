/**
 * Compressing a photograph in the browser before it is uploaded (D4.6).
 *
 * The motivation is bandwidth on a phone, not server cost. A modern camera
 * produces 4–8 MB per photo; a bride adding twenty gallery images on hotel
 * wi-fi at midnight is uploading 120 MB, and the failure mode is not an error
 * message but a tab she gives up on. Resizing to the largest size we will ever
 * display turns that into roughly 8 MB.
 *
 * Three things this is explicitly **not**:
 *
 *   • **Not a security control.** The worker re-sniffs, re-validates and
 *     re-encodes everything it receives. Nothing here is trusted; a client
 *     that skips this step entirely is handled identically.
 *   • **Not lossy where it matters.** It only ever downscales, and only past a
 *     threshold. A photo already smaller than the largest variant we render is
 *     returned untouched rather than round-tripped through a re-encode that
 *     could only make it worse.
 *   • **Not required.** Every failure path returns the original file. A
 *     browser without `createImageBitmap`, a codec it cannot decode, a canvas
 *     tainted for any reason — all of them fall through to uploading what the
 *     user picked.
 *
 * Kept framework-free so the builder (M5) and any later upload surface share
 * one implementation rather than each growing their own.
 */

/** The largest width any template renders (see VARIANT_WIDTHS in the renderer). */
export const MAX_UPLOAD_WIDTH = 1920;

/**
 * Below this, compression is not worth the quality cost.
 *
 * A 1.5 MB photo uploads in a second or two on any connection we care about,
 * and re-encoding it can only lose detail.
 */
export const COMPRESSION_THRESHOLD_BYTES = 1_500_000;

/** Matches the JPEG quality the server uses, so previews and output agree. */
export const CLIENT_JPEG_QUALITY = 0.82;

export interface CompressionResult {
  readonly file: File;
  /** False when the original was returned — undersized, unsupported, or failed. */
  readonly compressed: boolean;
  readonly originalBytes: number;
  readonly resultBytes: number;
  /** Present when compression was attempted and did not happen. */
  readonly reason?: string;
}

export interface CompressOptions {
  readonly maxWidth?: number;
  readonly thresholdBytes?: number;
  readonly quality?: number;
}

function unchanged(file: File, reason: string): CompressionResult {
  return {
    file,
    compressed: false,
    originalBytes: file.size,
    resultBytes: file.size,
    reason,
  };
}

/**
 * Whether this browser can do the work at all.
 *
 * `createImageBitmap` is the part that matters: it decodes off the main thread
 * and, on iOS Safari, is what makes HEIC decodable client-side at all.
 */
export function canCompressInBrowser(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof File !== 'undefined'
  );
}

export async function compressBeforeUpload(
  file: File,
  options: CompressOptions = {},
): Promise<CompressionResult> {
  const maxWidth = options.maxWidth ?? MAX_UPLOAD_WIDTH;
  const threshold = options.thresholdBytes ?? COMPRESSION_THRESHOLD_BYTES;
  const quality = options.quality ?? CLIENT_JPEG_QUALITY;

  if (!canCompressInBrowser()) return unchanged(file, 'browser lacks the required APIs');
  if (!file.type.startsWith('image/')) return unchanged(file, 'not an image');
  if (file.size <= threshold) return unchanged(file, 'already small enough');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A codec the browser cannot decode — a HEIC on desktop Chrome, say. The
    // server decodes it, so this is a missed optimisation, not a failure.
    return unchanged(file, 'browser cannot decode this format');
  }

  try {
    if (bitmap.width <= maxWidth) return unchanged(file, 'already within the display width');

    const scale = maxWidth / bitmap.width;
    const width = maxWidth;
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return unchanged(file, 'no 2d context');

    context.drawImage(bitmap, 0, 0, width, height);

    // JPEG rather than WebP or AVIF: the server re-encodes into all three
    // anyway, and JPEG is the one every browser can *produce*. Encoding to a
    // format some browsers only decode would silently fall back here.
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });

    // The canvas drops every metadata block, EXIF included, as a side effect
    // of how it works. Convenient, and still not relied upon: the worker
    // strips metadata from everything, including files that never came
    // through here.
    if (blob.size >= file.size) {
      // Re-encoding made it bigger, which happens with flat graphics. Keep the
      // original rather than upload something worse.
      return unchanged(file, 're-encoding did not reduce the size');
    }

    const renamed = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return {
      file: new File([blob], `${renamed}.jpg`, {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      }),
      compressed: true,
      originalBytes: file.size,
      resultBytes: blob.size,
    };
  } catch (error) {
    return unchanged(file, error instanceof Error ? error.message : 'compression failed');
  } finally {
    bitmap.close();
  }
}
