import { type Result, err, ok } from '@zfaf/shared';

/**
 * Invitation slug (ADR-0013).
 *
 * The slug becomes a link sent to hundreds of guests on WhatsApp, so it has to
 * be right the first time: unique, URL-safe, and unable to collide with a
 * platform route. Invitations live under `/i/{slug}`, which keeps the root
 * namespace free for future pages.
 */

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;

export const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 48;

export type SlugIssue =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'INVALID_CHARACTERS'
  | 'CONSECUTIVE_HYPHENS'
  | 'LEADING_OR_TRAILING_HYPHEN'
  | 'RESERVED'
  | 'EMPTY_AFTER_NORMALIZATION';

/**
 * Reserved slugs.
 *
 * Platform routes, infrastructure hostnames, and words that would produce a
 * misleading link. Kept as data so the list can grow without touching parsing.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // platform routes
  'api',
  'admin',
  'dashboard',
  'builder',
  'login',
  'logout',
  'register',
  'signup',
  'signin',
  'settings',
  'account',
  'billing',
  'pricing',
  'plans',
  'checkout',
  'templates',
  'template',
  'about',
  'help',
  'support',
  'contact',
  'blog',
  'docs',
  'terms',
  'privacy',
  'legal',
  'preview',
  'new',
  'edit',
  'search',
  'explore',
  // framework and asset paths
  '_next',
  'static',
  'assets',
  'public',
  'images',
  'fonts',
  'favicon',
  'robots',
  'sitemap',
  'manifest',
  'sw',
  'health',
  // this namespace itself
  'i',
  'invitation',
  'invitations',
  'q',
  'qr',
  'rsvp',
  // infrastructure hostnames
  'www',
  'mail',
  'smtp',
  'imap',
  'ftp',
  'cdn',
  'app',
  'staging',
  'test',
  'dev',
  'demo',
  'beta',
  'status',
  'ns1',
  'ns2',
  // values that read as bugs in a URL
  'null',
  'undefined',
  'true',
  'false',
  'nan',
  'none',
]);

/**
 * Arabic → Latin transliteration for slug suggestions.
 *
 * Deliberately lossy and approximate: the output is a starting point the user
 * can edit before publishing, not a linguistic transliteration standard.
 */
const ARABIC_TRANSLITERATION: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ا: 'a',
    أ: 'a',
    إ: 'i',
    آ: 'a',
    ٱ: 'a',
    ب: 'b',
    ت: 't',
    ث: 'th',
    ج: 'j',
    ح: 'h',
    خ: 'kh',
    د: 'd',
    ذ: 'dh',
    ر: 'r',
    ز: 'z',
    س: 's',
    ش: 'sh',
    ص: 's',
    ض: 'd',
    ط: 't',
    ظ: 'z',
    ع: 'a',
    غ: 'gh',
    ف: 'f',
    ق: 'q',
    ك: 'k',
    ل: 'l',
    م: 'm',
    ن: 'n',
    ه: 'h',
    و: 'w',
    ي: 'y',
    ى: 'a',
    ة: 'h',
    ء: '',
    ئ: 'y',
    ؤ: 'w',
    // Arabic-Indic digits
    '٠': '0',
    '١': '1',
    '٢': '2',
    '٣': '3',
    '٤': '4',
    '٥': '5',
    '٦': '6',
    '٧': '7',
    '٨': '8',
    '٩': '9',
  }),
);

/** Diacritics carry no information once transliterated. */
const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;

function transliterate(input: string): string {
  let output = '';
  for (const char of input.replace(ARABIC_DIACRITICS, '')) {
    output += ARABIC_TRANSLITERATION.get(char) ?? char;
  }
  return output;
}

/**
 * Normalizes arbitrary input toward a candidate slug.
 *
 * Exported because normalization is also what makes uniqueness meaningful:
 * "Ahmad-Sarah" and "ahmad-sarah" must not be two different invitations.
 */
export function normalizeSlug(input: string): string {
  return transliterate(input.normalize('NFC').trim().toLowerCase())
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class Slug {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /**
   * Parses a slug the user typed.
   *
   * Rejects rather than silently repairs: a user who types `My Wedding!!` should
   * see the suggestion `my-wedding` and confirm it, not discover after sending
   * 250 links that the platform chose something else.
   */
  static parse(input: string): Result<Slug, SlugIssue> {
    const normalized = input.normalize('NFC').trim().toLowerCase();

    if (normalized.length === 0) return err('EMPTY_AFTER_NORMALIZATION');
    if (/[^a-z0-9-]/.test(normalized)) return err('INVALID_CHARACTERS');
    if (normalized.length < MIN_SLUG_LENGTH) return err('TOO_SHORT');
    if (normalized.length > MAX_SLUG_LENGTH) return err('TOO_LONG');
    if (normalized.includes('--')) return err('CONSECUTIVE_HYPHENS');
    if (normalized.startsWith('-') || normalized.endsWith('-')) {
      return err('LEADING_OR_TRAILING_HYPHEN');
    }
    if (!SLUG_PATTERN.test(normalized)) return err('INVALID_CHARACTERS');
    if (RESERVED_SLUGS.has(normalized)) return err('RESERVED');

    return ok(new Slug(normalized));
  }

  /**
   * Suggests a slug from the couple's names, repairing what it can.
   *
   * Used to pre-fill the publish dialog. The user can still edit it.
   */
  static suggestFromNames(groomName: string, brideName: string): Result<Slug, SlugIssue> {
    const normalized = normalizeSlug(`${groomName} ${brideName}`).slice(0, MAX_SLUG_LENGTH);
    const trimmed = normalized.replace(/-+$/, '');
    if (trimmed.length === 0) return err('EMPTY_AFTER_NORMALIZATION');
    if (trimmed.length < MIN_SLUG_LENGTH) return err('TOO_SHORT');
    return Slug.parse(trimmed);
  }

  /**
   * Produces a collision-avoiding variant.
   *
   * The suffix is random rather than sequential on purpose: `-2` would confirm
   * that another invitation holds the base name and would let someone walk the
   * namespace by incrementing (ADR-0013).
   */
  withDisambiguator(suffix: string): Result<Slug, SlugIssue> {
    const cleaned = suffix.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleaned.length === 0) return err('INVALID_CHARACTERS');
    const room = MAX_SLUG_LENGTH - cleaned.length - 1;
    const base = this.value.slice(0, Math.max(MIN_SLUG_LENGTH, room)).replace(/-+$/, '');
    return Slug.parse(`${base}-${cleaned}`);
  }

  toString(): string {
    return this.value;
  }

  equals(other: Slug): boolean {
    return this.value === other.value;
  }
}

export function isReservedSlug(candidate: string): boolean {
  return RESERVED_SLUGS.has(candidate.trim().toLowerCase());
}
