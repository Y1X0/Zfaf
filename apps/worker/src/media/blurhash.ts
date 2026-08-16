import sharp from 'sharp';

/**
 * Blurhash encoding.
 *
 * A blurhash is ~30 characters that decode to a blurred approximation of an
 * image. It ships inside the published snapshot, so a guest sees the *shape*
 * of a photograph the instant the page paints rather than an empty rectangle
 * that jumps when the image lands. Layout stability on the public page is a
 * hard budget (docs/07-frontend-architecture.md §10).
 *
 * Implemented here rather than pulled in as a dependency: the algorithm is a
 * DCT over a tiny thumbnail and about sixty lines, and it is the kind of code
 * that should be readable at the point it is used.
 *
 * Reference: Wolt's blurhash specification, components 4×3.
 */

const COMPONENTS_X = 4;
const COMPONENTS_Y = 3;
/** The DCT runs over a thumbnail; the source resolution is irrelevant to it. */
const THUMB_SIZE = 32;

const BASE83 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function encodeBase83(value: number, length: number): string {
  let out = '';
  for (let index = 1; index <= length; index += 1) {
    const digit = Math.floor(value / 83 ** (length - index)) % 83;
    out += BASE83[digit];
  }
  return out;
}

/** sRGB → linear. Averaging gamma-encoded values darkens the result visibly. */
function toLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function toSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  const scaled = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(scaled * 255 + 0.5);
}

function signPow(value: number, exponent: number): number {
  return Math.sign(value) * Math.abs(value) ** exponent;
}

export async function encodeBlurhash(
  source: Uint8Array,
  /** Set when the source is already-decoded pixels rather than an encoded file. */
  rawInput: { raw: { width: number; height: number; channels: 4 } } | null = null,
): Promise<string> {
  const { data, info } = await sharp(source, { ...(rawInput ?? {}), animated: false })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const factors: number[][] = [];

  for (let y = 0; y < COMPONENTS_Y; y += 1) {
    for (let x = 0; x < COMPONENTS_X; x += 1) {
      const normalisation = x === 0 && y === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;

      for (let pixelY = 0; pixelY < height; pixelY += 1) {
        for (let pixelX = 0; pixelX < width; pixelX += 1) {
          const basis =
            normalisation *
            Math.cos((Math.PI * x * pixelX) / width) *
            Math.cos((Math.PI * y * pixelY) / height);
          const offset = 3 * (pixelY * width + pixelX);
          r += basis * toLinear(data[offset] as number);
          g += basis * toLinear(data[offset + 1] as number);
          b += basis * toLinear(data[offset + 2] as number);
        }
      }

      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc = factors[0] as number[];
  const ac = factors.slice(1);

  const sizeFlag = COMPONENTS_X - 1 + (COMPONENTS_Y - 1) * 9;
  let hash = encodeBase83(sizeFlag, 1);

  const actualMax = ac.length > 0 ? Math.max(...ac.flat().map(Math.abs)) : 0;
  const quantisedMax =
    ac.length > 0 ? Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5))) : 0;
  const maximum = ac.length > 0 ? (quantisedMax + 1) / 166 : 1;
  hash += encodeBase83(ac.length > 0 ? quantisedMax : 0, 1);

  const dcValue =
    (toSrgb(dc[0] as number) << 16) + (toSrgb(dc[1] as number) << 8) + toSrgb(dc[2] as number);
  hash += encodeBase83(dcValue, 4);

  for (const factor of ac) {
    const quantise = (value: number): number =>
      Math.max(0, Math.min(18, Math.floor(signPow(value / maximum, 0.5) * 9 + 9.5)));
    hash += encodeBase83(
      quantise(factor[0] as number) * 19 * 19 +
        quantise(factor[1] as number) * 19 +
        quantise(factor[2] as number),
      2,
    );
  }

  return hash;
}
