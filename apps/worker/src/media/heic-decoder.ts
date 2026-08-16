import { HeifDecoder, type HeifImage } from 'libheif-js';

import { MAX_IMAGE_PIXELS, type ProcessingFailure, checkImageDimensions } from '@zfaf/core';

/**
 * Decoding HEIC (ADR-0019).
 *
 * Sharp's prebuilt libvips reads a HEIC container but cannot decode its
 * pixels: the bundled libheif ships without an HEVC decoder, deliberately,
 * because HEVC patent licensing is a real liability. `metadata()` succeeding
 * on a HEIC is therefore misleading — it parses the header and never touches
 * the image data.
 *
 * So HEIC is decoded here, by libheif compiled to WebAssembly, and handed to
 * Sharp as raw pixels. Everything after that point — dimension checks,
 * re-encoding, variant generation — is the same code path every other format
 * takes.
 *
 * This module is the only place `libheif-js` may be imported, enforced by a
 * `dependency-cruiser` rule.
 */

export interface DecodedImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Always 4: libheif renders RGBA regardless of the source's subsampling. */
  readonly channels: 4;
}

export type HeicDecodeResult =
  | { readonly ok: true; readonly image: DecodedImage }
  /**
   * The failure carries the pipeline's own code rather than a boolean, so the
   * quarantine-versus-retry decision is made where the cause is known instead
   * of being re-derived from a message upstream.
   */
  | { readonly ok: false; readonly code: ProcessingFailure; readonly reason: string };

/**
 * Decodes the primary image from a HEIC file.
 *
 * Never throws: a decode failure is a returned value, so a queue handler is
 * never turned into a retry loop by a malformed file.
 */
export async function decodeHeic(source: Uint8Array): Promise<HeicDecodeResult> {
  let images: HeifImage[];
  try {
    images = new HeifDecoder().decode(source);
  } catch (error) {
    return { ok: false, code: 'FAILED_DECODE', reason: describe(error) };
  }

  // A HEIC commonly holds several items — the photograph plus a thumbnail, or
  // a burst. The first is the primary image, and the rest are not ours to
  // publish.
  const primary = images[0];
  if (!primary) {
    return {
      ok: false,
      code: 'QUARANTINE_REJECTED_FORMAT',
      reason: 'HEIC container holds no image item',
    };
  }

  const width = primary.get_width();
  const height = primary.get_height();

  // Checked *before* allocating. RGBA for a 12-megapixel photo is 48 MB, and a
  // forged header claiming far more would be an allocation attack rather than
  // a decode one (ADR-0019, implementation rules).
  const dimensions = checkImageDimensions(width, height);
  if (!dimensions.ok) {
    return { ok: false, code: 'QUARANTINE_DIMENSIONS', reason: dimensions.reason };
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    return { ok: false, code: 'QUARANTINE_DIMENSIONS', reason: 'HEIC exceeds the pixel budget' };
  }

  const target = { width, height, data: new Uint8ClampedArray(width * height * 4) };

  const rendered = await new Promise<Uint8ClampedArray | null>((resolve) => {
    try {
      primary.display(target, (result) => resolve(result ? result.data : null));
    } catch {
      resolve(null);
    }
  });

  if (!rendered) {
    return { ok: false, code: 'FAILED_DECODE', reason: 'HEIC pixel decode produced no data' };
  }

  return {
    ok: true,
    image: {
      data: new Uint8Array(rendered.buffer, rendered.byteOffset, rendered.length),
      width,
      height,
      channels: 4,
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
