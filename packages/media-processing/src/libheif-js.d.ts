/**
 * Type declarations for `libheif-js`, which ships none.
 *
 * Kept deliberately narrow: only the two calls `heic-decoder.ts` makes are
 * declared. A broad `any` would let a typo compile, and this is the one module
 * standing between an untrusted file and a pixel buffer.
 */
declare module 'libheif-js' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { width: number; height: number; data: Uint8ClampedArray },
      callback: (result: { data: Uint8ClampedArray } | null) => void,
    ): void;
  }

  export class HeifDecoder {
    decode(buffer: Uint8Array): HeifImage[];
  }

  /**
   * The module object itself.
   *
   * Declared because the package is CommonJS with a computed `module.exports`,
   * so the named export above cannot be imported directly under Node's ESM
   * loader — see the note in `heic-decoder.ts`.
   */
  const libheif: { HeifDecoder: typeof HeifDecoder };
  export default libheif;
}
