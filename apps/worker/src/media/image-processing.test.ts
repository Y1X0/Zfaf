import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_IMAGE_DIMENSION,
  VARIANT_ENCODINGS,
  VARIANT_WIDTHS,
  contentTypeMatches,
  sniffImageFormat,
} from '@zfaf/core';

import { attachExif, buildExifSegment } from './exif-fixture.js';
import { SharpImageProcessor } from './sharp-image-processor.js';

/**
 * The image processing pipeline, tested against real encoded images.
 *
 * Every fixture is produced by an actual encoder rather than hand-written, and
 * every assertion is made on the produced bytes. A test that checks "we called
 * a strip function" proves that we called a function; a test that searches the
 * output for GPS coordinates proves the coordinates are gone.
 */

const processor = new SharpImageProcessor();
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/**
 * A JPEG carrying the metadata a phone attaches, including GPS.
 *
 * The coordinates are a street address. That is the whole reason D4.4 step 6
 * exists: publishing a couple's photograph unstripped publishes where they
 * live.
 *
 * Built with `buildExifSegment` rather than Sharp's `withExif`, which silently
 * drops a GPS IFD — a fixture built that way would carry no GPS and every
 * assertion below would pass while proving nothing.
 */
const CAMERA_MAKE = 'ZfafTestCamera';
const CAMERA_MODEL = 'TestPhone15Pro';

async function jpegWithGpsExif(orientation = 1): Promise<Buffer> {
  const plain = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 190, g: 140, b: 90 } },
  })
    .jpeg()
    .toBuffer();

  return attachExif(
    plain,
    buildExifSegment({
      make: CAMERA_MAKE,
      model: CAMERA_MODEL,
      orientation,
      latitude: [24, 42, 49],
      longitude: [46, 40, 31],
      latitudeRef: 'N',
      longitudeRef: 'E',
    }),
  );
}

function contains(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'));
}

/** True when the EXIF block contains a GPS IFD pointer (tag 0x8825). */
function hasGpsIfd(exif: Uint8Array): boolean {
  return Buffer.from(exif).includes(Buffer.from([0x25, 0x88]));
}

// ── the mandatory test ─────────────────────────────────────────────────────

describe('metadata stripping', () => {
  let source: Buffer;

  beforeAll(async () => {
    source = await jpegWithGpsExif();
  });

  it('the fixture really does carry GPS metadata', async () => {
    // A guard on the test itself, and not a formality: the first version of
    // this fixture used Sharp's EXIF writer, which dropped the GPS block
    // without complaint. Without this assertion the whole suite below would
    // have been green and meaningless.
    const metadata = await sharp(source).metadata();
    expect(metadata.exif).toBeDefined();
    expect(hasGpsIfd(metadata.exif as Uint8Array), 'fixture has no GPS IFD').toBe(true);
    expect(contains(source, CAMERA_MAKE)).toBe(true);
    expect(contains(source, 'Exif\u0000\u0000')).toBe(true);
  });

  it('no output variant contains any EXIF block', async () => {
    const result = await processor.process(source, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const variant of result.image.variants) {
      const metadata = await sharp(variant.bytes).metadata();
      const label = `w${variant.width}.${variant.encoding}`;
      expect(metadata.exif, `${label} carries EXIF`).toBeUndefined();
      expect(metadata.iptc, `${label} carries IPTC`).toBeUndefined();
      expect(metadata.xmp, `${label} carries XMP`).toBeUndefined();
    }
  });

  it('no output variant contains the GPS block, coordinates or camera name', async () => {
    // Asserted on raw bytes as well as parsed metadata: a parser that does not
    // recognise a segment reports "no EXIF" for a file that still carries it.
    const result = await processor.process(source, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const variant of result.image.variants) {
      const label = `w${variant.width}.${variant.encoding}`;
      expect(contains(variant.bytes, CAMERA_MAKE), `${label} names the camera`).toBe(false);
      expect(contains(variant.bytes, CAMERA_MODEL), `${label} names the model`).toBe(false);
      expect(contains(variant.bytes, 'Exif\u0000\u0000'), `${label} has an Exif header`).toBe(
        false,
      );
      expect(hasGpsIfd(variant.bytes), `${label} still has a GPS IFD`).toBe(false);
      expect(contains(variant.bytes, 'http://ns.adobe.com/xap'), `${label} has XMP`).toBe(false);
    }
  });

  it('applies the EXIF orientation before discarding the tag', async () => {
    // Stripping orientation without applying it is the classic version of this
    // bug: the photo survives, correctly cleaned, and sideways.
    const rotated = await jpegWithGpsExif(6); // 6 = rotate 90° clockwise

    const asStored = await sharp(rotated).metadata();
    expect(asStored.orientation, 'fixture does not declare an orientation').toBe(6);

    const result = await processor.process(rotated, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const variant = result.image.variants.find((candidate) => candidate.encoding === 'jpeg');
    const metadata = await sharp(variant?.bytes as Uint8Array).metadata();
    // Stored 800×600 presented at orientation 6 should come out portrait.
    expect(metadata.height as number).toBeGreaterThan(metadata.width as number);
    expect(metadata.orientation).toBeUndefined();
  });
});

// ── format rejection ───────────────────────────────────────────────────────

describe('formats the pipeline refuses', () => {
  it('rejects an SVG, even when the client calls it a PNG', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const result = await processor.process(svg, 'image/png');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUARANTINE_REJECTED_FORMAT');
    expect(result.reason).toContain('script');
  });

  it('rejects a PHP script renamed and relabelled as a JPEG', async () => {
    // The canonical upload attack: correct extension, correct Content-Type,
    // and the first five bytes give it away.
    const php = Buffer.from('<?php system($_GET["c"]); ?>' + ' '.repeat(64));
    const result = await processor.process(php, 'image/jpeg');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUARANTINE_REJECTED_FORMAT');
    expect(result.reason).toContain('Executable script');
  });

  it.each([
    ['ELF binary', Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...new Array(60).fill(0)])],
    ['Windows executable', Buffer.from([0x4d, 0x5a, ...new Array(60).fill(0)])],
    ['ZIP archive', Buffer.from([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)])],
    ['PDF', Buffer.from('%PDF-1.7\n' + 'x'.repeat(60))],
    ['HTML', Buffer.from('<!DOCTYPE html><html><body>hi</body></html>')],
    ['shell script', Buffer.from('#!/bin/sh\nrm -rf /\n' + 'x'.repeat(40))],
    ['TIFF', Buffer.from([0x49, 0x49, 0x2a, 0x00, ...new Array(60).fill(0)])],
  ])('rejects a %s', async (_label, bytes) => {
    const result = await processor.process(bytes, 'image/jpeg');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUARANTINE_REJECTED_FORMAT');
  });

  it('quarantines a real image whose declared type does not match its bytes', async () => {
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: '#334455' },
    })
      .png()
      .toBuffer();

    const result = await processor.process(png, 'image/jpeg');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUARANTINE_FORMAT_MISMATCH');
  });

  it('never throws, whatever it is given', async () => {
    // A throw in a queue handler becomes a retry, and a retried hostile input
    // is an amplifier.
    const inputs = [
      new Uint8Array(0),
      new Uint8Array([0xff]),
      Buffer.from('not an image at all'),
      Buffer.alloc(2048, 0x41),
    ];
    for (const input of inputs) {
      await expect(processor.process(input, 'image/jpeg')).resolves.toMatchObject({ ok: false });
    }
  });
});

// ── decompression bombs ────────────────────────────────────────────────────

describe('decompression bombs', () => {
  it('refuses an image beyond the dimension limit', async () => {
    // A flat PNG of this size compresses to a few hundred kilobytes and costs
    // gigabytes to decode, which is the whole trick.
    const huge = await sharp({
      create: {
        width: MAX_IMAGE_DIMENSION + 500,
        height: 100,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const result = await processor.process(huge, 'image/png');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUARANTINE_DIMENSIONS');
  });

  it('refuses an implausible aspect ratio', async () => {
    const strip = await sharp({
      create: { width: 8000, height: 4, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .png()
      .toBuffer();

    const result = await processor.process(strip, 'image/png');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUARANTINE_DIMENSIONS');
  });
});

// ── derivatives ────────────────────────────────────────────────────────────

describe('derivatives', () => {
  it('produces every width in every encoding for a large source', async () => {
    const large = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: { r: 120, g: 90, b: 60 } },
    })
      .jpeg()
      .toBuffer();

    const result = await processor.process(large, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.image.variants).toHaveLength(VARIANT_WIDTHS.length * VARIANT_ENCODINGS.length);
    for (const width of VARIANT_WIDTHS) {
      for (const encoding of VARIANT_ENCODINGS) {
        const found = result.image.variants.find(
          (variant) => variant.width === width && variant.encoding === encoding,
        );
        expect(found, `missing w${width}.${encoding}`).toBeDefined();
        expect(found?.sizeBytes).toBeGreaterThan(0);
      }
    }
  });

  it('encodes each variant in the format it claims', async () => {
    const source = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 200, b: 210 } },
    })
      .png()
      .toBuffer();

    const result = await processor.process(source, 'image/png');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const variant of result.image.variants) {
      const metadata = await sharp(variant.bytes).metadata();
      const expected = variant.encoding === 'avif' ? 'heif' : variant.encoding;
      expect(metadata.format, `w${variant.width}.${variant.encoding}`).toBe(expected);
    }
  });

  it('never upscales a small image', async () => {
    // A 600px photo rendered at 1920 is blurry and larger — the worst of both.
    const small = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 30, b: 30 } },
    })
      .jpeg()
      .toBuffer();

    const result = await processor.process(small, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const variant of result.image.variants) {
      const metadata = await sharp(variant.bytes).metadata();
      expect(metadata.width as number).toBeLessThanOrEqual(600);
    }
  });

  it('produces a decodable blurhash', async () => {
    const source = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 220, g: 40, b: 40 } },
    })
      .jpeg()
      .toBuffer();

    const result = await processor.process(source, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 4×3 components encode to exactly 6 + 2×11 characters.
    expect(result.image.blurhash).toHaveLength(28);
    expect(result.image.blurhash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]+$/);
  });

  it('is deterministic for the same input', async () => {
    const source = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 77, g: 88, b: 99 } },
    })
      .png()
      .toBuffer();

    const first = await processor.process(source, 'image/png');
    const second = await processor.process(source, 'image/png');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.image.blurhash).toBe(second.image.blurhash);
  });
});

// ── HEIC ────────────────────────────────────────────────────────────────

/**
 * HEIC, the iPhone default.
 *
 * Two layers, because only one of them can run without a fixture we are
 * willing to commit:
 *
 *   • **Acceptance** always runs. A synthetic `ftyp` header is enough to prove
 *     that HEIC is recognised and routed to the decoder rather than rejected
 *     as an unknown format — the failure that would turn away a large share of
 *     users.
 *   • **End-to-end decode** needs a genuinely HEVC-coded file. We cannot
 *     generate one (the bundled libvips has an HEVC decoder but no encoder)
 *     and will not vendor a third-party photograph of unclear licence into a
 *     commercial repository. `pnpm --filter @zfaf/worker fixtures:heic`
 *     fetches one into a gitignored directory; this test runs when it is
 *     present and is skipped, visibly, when it is not.
 */
describe('HEIC, the iPhone default', () => {
  /** An `ftyp` box declaring HEIC brands, with no image data behind it. */
  function heicHeader(majorBrand: string, compatible: readonly string[]): Uint8Array {
    const brands = [majorBrand, '\u0000\u0000\u0000\u0000', ...compatible].join('');
    const size = 8 + brands.length;
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(size, 0);
    bytes.write('ftyp', 4, 'latin1');
    bytes.write(brands, 8, 'latin1');
    return new Uint8Array(bytes);
  }

  it.each([
    ['heic', ['heic', 'mif1']],
    ['mif1', ['mif1', 'heic', 'hevc']],
    ['heix', ['heix', 'mif1']],
  ])('recognises a %s-branded file as HEIC', (major, compatible) => {
    // The precise claim: the sniffer routes these to the decoder rather than
    // rejecting them as an unknown format, which is the failure that would
    // turn away every iPhone user.
    const result = sniffImageFormat(heicHeader(major, compatible));
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(result.format).toBe('heic');
  });

  it.each(['image/heic', 'image/heif'])('accepts the %s spelling', (contentType) => {
    // Safari labels HEIC as HEIF; rejecting that spelling turns away iPhones.
    expect(contentTypeMatches(contentType, 'heic')).toBe(true);
  });

  it('fails a header-only HEIC without throwing', async () => {
    const result = await processor.process(heicHeader('heic', ['heic', 'mif1']), 'image/heic');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Terminal, not retryable: a container with no image item will never
    // become one.
    expect(result.code).toBe('QUARANTINE_REJECTED_FORMAT');
  });

  const heicPath = resolve(fixtures, 'sample.heic');
  const hasFixture = existsSync(heicPath);

  // Generous on purpose. WASM decoding plus nine encodes of a 1.1-megapixel
  // photograph takes seconds, which ADR-0019 accepts because it happens in a
  // background worker rather than a request.
  it.skipIf(!hasFixture)(
    'processes a real HEVC-coded photograph end to end',
    { timeout: 60_000 },
    async () => {
      const bytes = readFileSync(heicPath);
      // Guards the fixture: an AVIF file wearing a HEIC brand would pass the
      // assertions below while proving nothing about what iPhones produce.
      expect(bytes.includes(Buffer.from('hvcC')), 'fixture is not HEVC-coded').toBe(true);

      const result = await processor.process(bytes, 'image/heic');
      expect(result.ok, result.ok ? '' : `${result.code}: ${result.reason}`).toBe(true);
      if (!result.ok) return;

      expect(result.image.sourceFormat).toBe('heic');
      expect(result.image.width).toBeGreaterThan(0);
      expect(result.image.variants.length).toBeGreaterThan(0);
      for (const variant of result.image.variants) {
        const metadata = await sharp(variant.bytes).metadata();
        expect(metadata.exif).toBeUndefined();
      }
    },
  );
});
