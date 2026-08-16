/**
 * The user's filename.
 *
 * It is display data and nothing else. It never reaches a storage key, a
 * filesystem path, or a shell — `buildMediaKey` composes keys from server-side
 * identifiers only, and this module exists so the value we *show* is also safe
 * (docs/10-storage-and-media.md §3).
 *
 * Two separate jobs, deliberately not merged: sanitising for display, and
 * deriving an extension. Callers that only need one should not silently get
 * the other.
 */

export const MAX_FILENAME_LENGTH = 120;

/**
 * Makes a filename safe to store and render.
 *
 * Strips path separators, control characters, and the Unicode direction
 * overrides used to disguise an extension — `photo‮gnp.exe` renders as
 * `photo.exe...` in a right-to-left interface, which is a real trick and one
 * an Arabic-first product will meet.
 */
export function sanitiseOriginalFilename(input: string): string {
  const withoutPath = input.split(/[/\\]/).pop() ?? '';

  const cleaned = withoutPath
    // Control characters, and the bidi overrides specifically. The rule that
    // bans control characters in a regular expression is right in general and
    // wrong here: stripping them is the entire purpose.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    // Collapse runs of dots so `..` cannot survive in any form.
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim();

  if (cleaned.length === 0) return 'upload';
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  // Truncate the stem, keep the extension: a user recognises `IMG_0421….heic`
  // far more readily than a name cut off mid-word.
  const lastDot = cleaned.lastIndexOf('.');
  if (lastDot <= 0 || cleaned.length - lastDot > 12) {
    return cleaned.slice(0, MAX_FILENAME_LENGTH);
  }
  const extension = cleaned.slice(lastDot);
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
}

/**
 * The extension used for a stored object.
 *
 * Derived from the **sniffed format**, never from the uploaded name. A file
 * called `x.jpg` that is really a PNG is stored as `.png`, because the
 * extension in a key should describe the bytes.
 */
export function storageExtensionFor(format: string): string {
  const table: Readonly<Record<string, string>> = {
    jpeg: 'jpg',
    png: 'png',
    webp: 'webp',
    avif: 'avif',
    heic: 'heic',
    gif: 'gif',
  };
  return table[format] ?? 'bin';
}
