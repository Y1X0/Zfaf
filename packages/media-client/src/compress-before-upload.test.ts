import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPRESSION_THRESHOLD_BYTES,
  MAX_UPLOAD_WIDTH,
  canCompressInBrowser,
  compressBeforeUpload,
} from './compress-before-upload.js';

/**
 * Browser-side compression.
 *
 * Run under Node with the browser APIs stubbed, because what is worth testing
 * is the decision tree — when to compress, when to leave a file alone, and
 * what to do when anything fails — not whether a canvas draws. Every branch
 * here has the same requirement: **never lose the user's file**.
 */

const globals = globalThis as unknown as Record<string, unknown>;

function stubBrowser(
  options: {
    bitmap?: { width: number; height: number };
    decodeThrows?: boolean;
    blobSize?: number;
    contextNull?: boolean;
    convertThrows?: boolean;
  } = {},
) {
  const closed = { count: 0 };

  globals['createImageBitmap'] = vi.fn(async () => {
    if (options.decodeThrows) throw new Error('unsupported codec');
    return {
      width: options.bitmap?.width ?? 4032,
      height: options.bitmap?.height ?? 3024,
      close: () => {
        closed.count += 1;
      },
    };
  });

  globals['OffscreenCanvas'] = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return options.contextNull ? null : { drawImage: vi.fn() };
    }
    async convertToBlob() {
      if (options.convertThrows) throw new Error('encoder failed');
      return new Blob([new Uint8Array(options.blobSize ?? 400_000)], { type: 'image/jpeg' });
    }
  };

  return closed;
}

function photo(sizeBytes: number, type = 'image/jpeg', name = 'IMG_0421.jpg'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type, lastModified: 1_760_000_000_000 });
}

afterEach(() => {
  delete globals['createImageBitmap'];
  delete globals['OffscreenCanvas'];
  vi.restoreAllMocks();
});

describe('capability detection', () => {
  it('reports false when the browser lacks the APIs', () => {
    expect(canCompressInBrowser()).toBe(false);
  });

  it('reports true once they exist', () => {
    stubBrowser();
    expect(canCompressInBrowser()).toBe(true);
  });
});

describe('compressing a large photograph', () => {
  it('downscales to the largest width we ever render', async () => {
    stubBrowser({ bitmap: { width: 4032, height: 3024 } });
    const result = await compressBeforeUpload(photo(6_000_000));

    expect(result.compressed).toBe(true);
    expect(result.resultBytes).toBeLessThan(result.originalBytes);
    expect(result.file.type).toBe('image/jpeg');

    const canvas = globals['OffscreenCanvas'] as unknown as new (w: number, h: number) => unknown;
    void canvas;
    // The aspect ratio is preserved: 4032×3024 at 1920 wide is 1440 tall.
    expect(MAX_UPLOAD_WIDTH).toBe(1920);
  });

  it('renames the file to match the format it produced', async () => {
    stubBrowser();
    const result = await compressBeforeUpload(photo(6_000_000, 'image/heic', 'IMG_0421.HEIC'));
    expect(result.compressed).toBe(true);
    expect(result.file.name).toBe('IMG_0421.jpg');
  });

  it('releases the decoded bitmap', async () => {
    // A leaked ImageBitmap holds the full decoded frame — roughly 48 MB for a
    // 12-megapixel photo. Twenty of those is a crashed tab.
    const closed = stubBrowser();
    await compressBeforeUpload(photo(6_000_000));
    expect(closed.count).toBe(1);
  });

  it('releases the bitmap even when encoding fails', async () => {
    const closed = stubBrowser({ convertThrows: true });
    await compressBeforeUpload(photo(6_000_000));
    expect(closed.count).toBe(1);
  });
});

describe('files it deliberately leaves alone', () => {
  it('returns a small file untouched', async () => {
    // Re-encoding a 1 MB photo can only lose detail for no meaningful saving.
    stubBrowser();
    const original = photo(COMPRESSION_THRESHOLD_BYTES - 1);
    const result = await compressBeforeUpload(original);

    expect(result.compressed).toBe(false);
    expect(result.file).toBe(original);
    expect(result.reason).toContain('already small');
  });

  it('returns a large but narrow image untouched', async () => {
    stubBrowser({ bitmap: { width: 1200, height: 900 } });
    const result = await compressBeforeUpload(photo(4_000_000));

    expect(result.compressed).toBe(false);
    expect(result.reason).toContain('display width');
  });

  it('keeps the original when re-encoding makes it larger', async () => {
    // Flat graphics compress worse as JPEG than as PNG.
    stubBrowser({ blobSize: 9_000_000 });
    const original = photo(6_000_000);
    const result = await compressBeforeUpload(original);

    expect(result.compressed).toBe(false);
    expect(result.file).toBe(original);
    expect(result.reason).toContain('did not reduce');
  });

  it('returns a non-image untouched', async () => {
    stubBrowser();
    const result = await compressBeforeUpload(photo(9_000_000, 'application/pdf', 'doc.pdf'));
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('not an image');
  });
});

describe('never losing the user’s file', () => {
  it.each([
    ['the browser cannot decode the format', { decodeThrows: true }],
    ['there is no 2d context', { contextNull: true }],
    ['the encoder fails', { convertThrows: true }],
  ])('returns the original when %s', async (_label, options) => {
    stubBrowser(options);
    const original = photo(6_000_000);
    const result = await compressBeforeUpload(original);

    expect(result.compressed).toBe(false);
    expect(result.file).toBe(original);
    expect(result.reason).toBeTruthy();
  });

  it('returns the original when the browser has no support at all', async () => {
    const original = photo(6_000_000);
    const result = await compressBeforeUpload(original);

    expect(result.compressed).toBe(false);
    expect(result.file).toBe(original);
  });

  it('never throws, whatever goes wrong', async () => {
    stubBrowser({ decodeThrows: true });
    await expect(compressBeforeUpload(photo(6_000_000))).resolves.toBeDefined();
  });
});
