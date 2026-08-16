/**
 * Image format identification from the bytes themselves.
 *
 * The client tells us three things about an upload — the extension, the
 * `Content-Type` header, and the declared size — and **none of them is
 * evidence**. A PHP script renamed to `photo.jpg` and sent with
 * `Content-Type: image/jpeg` satisfies every one of them.
 *
 * This module answers the only question that matters: what do the first bytes
 * actually say the file is? It runs in the worker after the upload lands, and
 * a mismatch quarantines the object rather than processing it
 * (docs/10-storage-and-media.md §4).
 *
 * Framework-free and synchronous, operating on a `Uint8Array`, so the same
 * function runs in the worker, in a test, and — if we ever need it — at the
 * edge.
 */

export const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'heic', 'gif'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Enough bytes for every signature below, including the ISO-BMFF brand list. */
export const SNIFF_BYTES = 64;

export type SniffResult =
  | { readonly kind: 'image'; readonly format: ImageFormat; readonly mimeType: string }
  | { readonly kind: 'rejected'; readonly reason: string; readonly detected: string };

const MIME_BY_FORMAT: Readonly<Record<ImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  gif: 'image/gif',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] as number);
  }
  return out;
}

/**
 * Brands that appear in an ISO base-media container's `ftyp` box.
 *
 * AVIF and HEIC share a container, so the brand — not the extension — decides
 * which one arrived. The compatible-brand list is scanned too, because a real
 * iPhone file often declares `mif1` as its major brand and only mentions
 * `heic` further along.
 */
const AVIF_BRANDS = new Set(['avif', 'avis', 'av01']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

function sniffIsoBaseMedia(bytes: Uint8Array): SniffResult | null {
  if (asciiAt(bytes, 4, 4) !== 'ftyp') return null;

  const brands: string[] = [asciiAt(bytes, 8, 4)];
  // The `ftyp` box length bounds the compatible-brand list. Clamp to what we
  // actually read so a forged length cannot walk us off the buffer.
  const declared =
    ((bytes[0] as number) << 24) |
    ((bytes[1] as number) << 16) |
    ((bytes[2] as number) << 8) |
    (bytes[3] as number);
  const end = Math.min(declared > 0 ? declared : bytes.length, bytes.length);

  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.push(asciiAt(bytes, offset, 4));
  }

  // AVIF is checked first: a file declaring both is the one we can re-encode
  // to natively, and treating it as HEIC would take a slower path for nothing.
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) {
    return { kind: 'image', format: 'avif', mimeType: MIME_BY_FORMAT.avif };
  }
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) {
    return { kind: 'image', format: 'heic', mimeType: MIME_BY_FORMAT.heic };
  }

  return {
    kind: 'rejected',
    reason: 'ISO base-media container with no image brand we accept',
    detected: `ftyp:${brands.filter(Boolean).join(',')}`,
  };
}

/**
 * Formats we refuse by signature, each for a stated reason.
 *
 * Naming them explicitly means the rejection message tells a user what they
 * uploaded, instead of "invalid file".
 */
const REJECTED_SIGNATURES: readonly {
  readonly label: string;
  readonly reason: string;
  readonly test: (bytes: Uint8Array) => boolean;
}[] = [
  {
    label: 'svg',
    // The reason this list exists at all. SVG is XML, XML can carry a
    // <script> element, and an <img> that is really a script is stored XSS.
    reason: 'SVG can carry executable script and is never accepted',
    test: (bytes) => {
      const head = asciiAt(bytes, 0, Math.min(bytes.length, SNIFF_BYTES)).trimStart().toLowerCase();
      return head.startsWith('<svg') || head.startsWith('<?xml');
    },
  },
  {
    label: 'php',
    reason: 'Executable script, not an image',
    test: (bytes) => asciiAt(bytes, 0, 5).toLowerCase() === '<?php',
  },
  {
    label: 'html',
    reason: 'HTML is not an image',
    test: (bytes) => {
      const head = asciiAt(bytes, 0, Math.min(bytes.length, SNIFF_BYTES)).trimStart().toLowerCase();
      return head.startsWith('<!doctype html') || head.startsWith('<html');
    },
  },
  {
    label: 'script',
    reason: 'Shell script, not an image',
    test: (bytes) => asciiAt(bytes, 0, 2) === '#!',
  },
  {
    label: 'elf',
    reason: 'Executable binary, not an image',
    test: (bytes) => startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]),
  },
  {
    label: 'pe',
    reason: 'Executable binary, not an image',
    test: (bytes) => startsWith(bytes, [0x4d, 0x5a]),
  },
  {
    label: 'zip',
    // Also catches Office documents and JARs, which share the signature.
    reason: 'Archive, not an image',
    test: (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]),
  },
  {
    label: 'pdf',
    reason: 'PDF is not an image',
    test: (bytes) => asciiAt(bytes, 0, 5) === '%PDF-',
  },
  {
    label: 'tiff',
    reason: 'TIFF has a large decoder attack surface and no user benefit',
    test: (bytes) =>
      startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  {
    label: 'bmp',
    reason: 'BMP is uncompressed and offers nothing the accepted formats do not',
    test: (bytes) => startsWith(bytes, [0x42, 0x4d]),
  },
];

/**
 * Identifies an upload from its leading bytes.
 *
 * Never throws and never guesses: anything it does not positively recognise is
 * rejected. A default of "probably fine" is how the one file that matters gets
 * through.
 */
export function sniffImageFormat(bytes: Uint8Array): SniffResult {
  if (bytes.length < 12) {
    return { kind: 'rejected', reason: 'File is too short to be an image', detected: 'truncated' };
  }

  for (const candidate of REJECTED_SIGNATURES) {
    if (candidate.test(bytes)) {
      return { kind: 'rejected', reason: candidate.reason, detected: candidate.label };
    }
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', format: 'jpeg', mimeType: MIME_BY_FORMAT.jpeg };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', format: 'png', mimeType: MIME_BY_FORMAT.png };
  }
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return { kind: 'image', format: 'webp', mimeType: MIME_BY_FORMAT.webp };
  }
  if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') {
    return { kind: 'image', format: 'gif', mimeType: MIME_BY_FORMAT.gif };
  }

  const isoBaseMedia = sniffIsoBaseMedia(bytes);
  if (isoBaseMedia) return isoBaseMedia;

  return {
    kind: 'rejected',
    reason: 'Unrecognised file format',
    detected: `bytes:${[...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
  };
}

/**
 * Checks the sniffed format against what the client claimed.
 *
 * A mismatch is not automatically an attack — a browser labelling a HEIC as
 * `image/jpeg` happens — but it means the claim is worthless, so the sniffed
 * type is what gets recorded. The mismatch itself is worth surfacing.
 */
export function contentTypeMatches(claimed: string, sniffed: ImageFormat): boolean {
  const normalised = claimed.toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalised === MIME_BY_FORMAT[sniffed]) return true;
  // The two spellings each format is known by in the wild.
  const aliases: Readonly<Record<ImageFormat, readonly string[]>> = {
    jpeg: ['image/jpg', 'image/pjpeg'],
    png: ['image/x-png'],
    webp: [],
    avif: ['image/avif-sequence'],
    heic: ['image/heif', 'image/heic-sequence', 'image/heif-sequence'],
    gif: [],
  };
  return aliases[sniffed].includes(normalised);
}

// ── decompression-bomb limits ──────────────────────────────────────────────

/**
 * Dimension limits.
 *
 * A 64000×64000 PNG is a few hundred kilobytes on disk and 12 GB once decoded.
 * The byte-size limit in the upload signature does nothing about it, so pixels
 * are bounded separately (docs/10 §4 steps 4–5).
 */
export const MAX_IMAGE_DIMENSION = 12_000;
export const MAX_IMAGE_PIXELS = 60_000_000;
/** Panoramas are legitimate; a 1×200000 strip is not. */
export const MAX_ASPECT_RATIO = 20;

export type DimensionCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkImageDimensions(width: number, height: number): DimensionCheck {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { ok: false, reason: 'Image reports no usable dimensions' };
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return {
      ok: false,
      reason: `Image exceeds ${MAX_IMAGE_DIMENSION}px on a side (${width}×${height})`,
    };
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    return {
      ok: false,
      reason: `Image exceeds ${MAX_IMAGE_PIXELS} pixels (${width}×${height})`,
    };
  }
  const ratio = Math.max(width / height, height / width);
  if (ratio > MAX_ASPECT_RATIO) {
    return { ok: false, reason: `Aspect ratio ${ratio.toFixed(1)}:1 is implausible for a photo` };
  }
  return { ok: true };
}
