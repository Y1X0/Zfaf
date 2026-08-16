import sharp, { type Metadata, type Sharp } from 'sharp';

import {
  ENCODING_QUALITY,
  type ImageProcessor,
  MAX_IMAGE_PIXELS,
  type ProcessedVariant,
  type ProcessingResult,
  VARIANT_ENCODINGS,
  VARIANT_WIDTHS,
  type VariantEncoding,
  type VariantWidth,
  checkImageDimensions,
  contentTypeMatches,
  sniffImageFormat,
} from '@zfaf/core';

import { encodeBlurhash } from './blurhash.js';
import { decodeHeic } from './heic-decoder.js';

/**
 * The image processing pipeline (D4.4, D4.5).
 *
 * The order of the steps is the security design, not a convenience:
 *
 *   1. **Sniff the bytes.** Everything after this point acts on what the file
 *      *is*, never on what it claimed to be.
 *   2. **Bound the pixels** before decoding at full size. A 400 KB PNG can
 *      declare 64000×64000 and cost 12 GB of RAM to decode.
 *   3. **Re-encode completely.** This is the strongest defence in the whole
 *      pipeline: decoding to raw pixels and encoding fresh produces a file
 *      containing nothing but the picture. Any payload that survived the
 *      earlier checks does not survive this.
 *   4. **Emit no metadata.** Sharp drops EXIF, IPTC and XMP unless asked to
 *      keep them, and this pipeline never asks. A phone photo carries the GPS
 *      coordinates of the couple's home; publishing it unstripped publishes
 *      their address (docs/10-storage-and-media.md §4 step 6).
 *
 * Nothing here throws. A queue handler that throws gets retried, and retrying
 * a decompression bomb turns one hostile upload into an outage.
 */

export class SharpImageProcessor implements ImageProcessor {
  async process(source: Uint8Array, claimedContentType: string): Promise<ProcessingResult> {
    const sniffed = sniffImageFormat(source);
    if (sniffed.kind === 'rejected') {
      return {
        ok: false,
        code: 'QUARANTINE_REJECTED_FORMAT',
        reason: `${sniffed.reason} (detected ${sniffed.detected})`,
      };
    }

    if (!contentTypeMatches(claimedContentType, sniffed.format)) {
      // Not automatically an attack — browsers do mislabel HEIC — but the
      // claim is now known to be worthless, so it is recorded and the file is
      // held rather than processed on a false premise.
      return {
        ok: false,
        code: 'QUARANTINE_FORMAT_MISMATCH',
        reason: `Client claimed "${claimedContentType}" but the bytes are ${sniffed.format}`,
      };
    }

    // HEIC is decoded separately and handed on as raw pixels: the bundled
    // libvips parses the container but cannot decode HEVC (ADR-0019). Every
    // step after this one is identical for every format.
    let decodable: Uint8Array = source;
    let rawInput: { raw: { width: number; height: number; channels: 4 } } | null = null;

    if (sniffed.format === 'heic') {
      const decoded = await decodeHeic(source);
      if (!decoded.ok) return { ok: false, code: decoded.code, reason: decoded.reason };
      decodable = decoded.image.data;
      rawInput = {
        raw: {
          width: decoded.image.width,
          height: decoded.image.height,
          channels: decoded.image.channels,
        },
      };
    }

    let pipeline: Sharp;
    let metadata: Metadata;
    try {
      pipeline = sharp(decodable, {
        ...(rawInput ?? {}),
        // Refuses the decode outright rather than allocating and then
        // discovering the problem.
        limitInputPixels: MAX_IMAGE_PIXELS,
        // An animated GIF becomes its first frame: we display invitations, not
        // animations, and the frame count is otherwise unbounded work.
        animated: false,
        failOn: 'error',
      });
      metadata = await pipeline.metadata();
    } catch (error) {
      return { ok: false, code: 'FAILED_DECODE', reason: describe(error) };
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    const dimensions = checkImageDimensions(width, height);
    if (!dimensions.ok) {
      return { ok: false, code: 'QUARANTINE_DIMENSIONS', reason: dimensions.reason };
    }

    let blurhash: string;
    try {
      blurhash = await encodeBlurhash(decodable, rawInput);
    } catch (error) {
      return { ok: false, code: 'FAILED_DECODE', reason: `blurhash: ${describe(error)}` };
    }

    const variants: ProcessedVariant[] = [];
    try {
      for (const targetWidth of VARIANT_WIDTHS) {
        // Never upscale: a 600px photo rendered at 1920 is blurry *and*
        // larger, which is the worst of both.
        if (targetWidth > width && variants.some((variant) => variant.width < targetWidth)) {
          continue;
        }
        for (const encoding of VARIANT_ENCODINGS) {
          variants.push(
            await this.renderVariant(decodable, rawInput, targetWidth, encoding, width, height),
          );
        }
      }
    } catch (error) {
      return { ok: false, code: 'FAILED_ENCODE', reason: describe(error) };
    }

    return {
      ok: true,
      image: { sourceFormat: sniffed.format, width, height, blurhash, variants },
    };
  }

  private async renderVariant(
    source: Uint8Array,
    rawInput: { raw: { width: number; height: number; channels: 4 } } | null,
    targetWidth: VariantWidth,
    encoding: VariantEncoding,
    sourceWidth: number,
    sourceHeight: number,
  ): Promise<ProcessedVariant> {
    const effectiveWidth = Math.min(targetWidth, sourceWidth);
    const effectiveHeight = Math.max(1, Math.round((effectiveWidth / sourceWidth) * sourceHeight));

    // A fresh pipeline per variant. Reusing one across encodings is how a
    // setting applied for AVIF quietly leaks into the JPEG.
    let pipeline = sharp(source, {
      ...(rawInput ?? {}),
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
    })
      // Applies the EXIF orientation *before* the tag is discarded. Raw pixel
      // input carries no orientation to apply, and `rotate()` is a no-op there.
      .rotate()
      .resize({ width: effectiveWidth, withoutEnlargement: true, fit: 'inside' });

    switch (encoding) {
      case 'avif':
        pipeline = pipeline.avif({ quality: ENCODING_QUALITY.avif, effort: 4 });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality: ENCODING_QUALITY.webp });
        break;
      case 'jpeg':
        // Progressive: the picture appears at low quality immediately rather
        // than filling in top-to-bottom on a slow connection.
        pipeline = pipeline.jpeg({
          quality: ENCODING_QUALITY.jpeg,
          progressive: true,
          mozjpeg: true,
        });
        break;
    }

    // No `.withMetadata()` anywhere in this file, and no `keepExif`. Sharp's
    // default is to emit none, and that default is load-bearing here.
    const bytes = await pipeline.toBuffer();

    return {
      width: targetWidth,
      height: effectiveHeight,
      encoding,
      bytes: new Uint8Array(bytes),
      sizeBytes: bytes.byteLength,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
