import QRCode from 'qrcode';

/**
 * Static QR codes (ADR-0016).
 *
 * The code encodes the public invitation URL directly. No intermediate
 * redirect, no tracking, no third-party service — the last of those matters
 * most: sending an invitation link to an external QR API would hand a stranger
 * the addresses of every wedding on the platform, for a job that takes a
 * millisecond locally.
 *
 * Encoding directly is also why a printed card keeps working. Three hundred
 * paper invitations cannot be reissued; a code pointing at an intermediate
 * route stops working the day that route changes or the service goes down,
 * while a direct link depends only on the domain resolving.
 *
 * Generation is deterministic: the same URL always produces the same image, so
 * nothing needs storing and a reprint matches the original exactly.
 */

/** ~15% recovery. Enough for a smudged card, not so much that the code grows. */
const ERROR_CORRECTION = 'M' as const;

export const QR_MIN_SIZE = 256;
export const QR_MAX_SIZE = 2048;
export const QR_DEFAULT_SIZE = 1024;

export function clampQrSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return QR_DEFAULT_SIZE;
  return Math.min(QR_MAX_SIZE, Math.max(QR_MIN_SIZE, Math.round(requested)));
}

/**
 * SVG, for print.
 *
 * Vector rather than a large raster because the usual destination is a printer
 * at a size nobody tells us in advance — a card, a table sign, a poster in the
 * hall. A raster picks its resolution at generation time and is wrong for two
 * of those three.
 */
export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: ERROR_CORRECTION,
    // Four modules is the quiet zone the spec requires. Scanners fail on codes
    // printed flush against other ink, and that failure appears only after the
    // cards are printed.
    margin: 4,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

/** PNG, for sharing in a chat where SVG is not rendered. */
export async function qrPng(url: string, size: number = QR_DEFAULT_SIZE): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: 4,
    width: clampQrSize(size),
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
