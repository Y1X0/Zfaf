import { DEFAULT_LOCALE, type Locale } from './routing.js';

/**
 * The address of a path in a given locale (D9.1).
 *
 * A pure function rather than next-intl's `Link`, and that is a performance
 * decision with a measured number behind it. `Link` is a client component: one
 * of them anywhere on a page pulls React's whole client runtime into a
 * document that otherwise needs none. Measured on the marketing pages, that is
 * **157 KB against a 144 KB budget** (ADR-0021) — versus 8 KB when every link is a plain
 * `<a>`.
 *
 * The marketing and legal pages are text. Full-page navigation between them is
 * not a regression; shipping a router to avoid it is.
 *
 * The prefix rule lives here, once, so a call site writes `/pricing` and the
 * right address comes out in either language — which is the one thing `Link`
 * was buying us.
 */
export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  // Arabic is unprefixed (`localePrefix: 'as-needed'`), so `/` stays `/`.
  if (locale === DEFAULT_LOCALE) return clean;
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`;
}

/**
 * The same path in the other language.
 *
 * Takes the *current* pathname so the switch keeps the reader where they are —
 * losing someone's place is exactly when they give up on switching.
 */
export function otherLocalePath(locale: Locale, pathname: string): string {
  const other: Locale = locale === 'ar' ? 'en' : 'ar';
  const bare = stripLocale(pathname);
  return localePath(other, bare);
}

/** Removes a leading locale segment, leaving the path the two locales share. */
export function stripLocale(pathname: string): string {
  const match = /^\/(ar|en)(\/.*)?$/.exec(pathname);
  if (!match) return pathname || '/';
  return match[2] ?? '/';
}
