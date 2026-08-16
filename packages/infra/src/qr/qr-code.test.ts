import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

import { QR_MAX_SIZE, QR_MIN_SIZE, clampQrSize, qrPng, qrSvg } from './qr-code.js';

/**
 * These tests decode the codes rather than inspecting them.
 *
 * A test that asserts "the PNG is more than 1000 bytes" or "the SVG contains
 * `<path`" passes just as happily for a QR code that encodes the wrong URL, or
 * one no scanner can read. The acceptance criterion is that scanning it opens
 * the invitation, so the test decodes the pixels and compares the string.
 *
 * The one thing this cannot prove is that a *phone camera* reads it off paper.
 * That stays an explicit manual gate.
 */

const URL = 'https://zfaf.app/i/ahmad-sara';

function decodePng(png: Buffer): string | null {
  const image = PNG.sync.read(png);
  const result = jsQR(Uint8ClampedArray.from(image.data), image.width, image.height);
  return result?.data ?? null;
}

describe('qrPng', () => {
  it('encodes exactly the public invitation URL', async () => {
    expect(decodePng(await qrPng(URL))).toBe(URL);
  });

  it('is deterministic, so a reprint matches the original', async () => {
    const [first, second] = await Promise.all([qrPng(URL), qrPng(URL)]);
    expect(first.equals(second)).toBe(true);
  });

  it('stays readable at the smallest size we offer', async () => {
    expect(decodePng(await qrPng(URL, QR_MIN_SIZE))).toBe(URL);
  });

  it('encodes a long slug without becoming unreadable', async () => {
    const long = `https://zfaf.app/i/${'a'.repeat(48)}`;
    expect(decodePng(await qrPng(long))).toBe(long);
  });

  it('is a PNG, whatever the caller asked for', async () => {
    const png = await qrPng(URL);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('qrSvg', () => {
  it('produces a vector document', async () => {
    const svg = await qrSvg(URL);
    expect(svg.startsWith('<?xml') || svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox');
  });

  it('carries no script, because it may be opened in a browser', async () => {
    const svg = await qrSvg(URL);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('onload');
  });

  it('is deterministic', async () => {
    expect(await qrSvg(URL)).toBe(await qrSvg(URL));
  });
});

describe('clampQrSize', () => {
  it('refuses a size that would let a caller ask for a huge render', () => {
    expect(clampQrSize(1_000_000)).toBe(QR_MAX_SIZE);
  });

  it('refuses a size too small to scan', () => {
    expect(clampQrSize(1)).toBe(QR_MIN_SIZE);
  });

  it('falls back rather than producing NaN', () => {
    expect(clampQrSize(Number.NaN)).toBe(1024);
    expect(clampQrSize(undefined)).toBe(1024);
  });
});
