import { defineRouting } from 'next-intl/routing';

/**
 * Locale routing (D9.1, ADR-0011).
 *
 * ## Arabic has no prefix, and that is the decision
 *
 * ADR-0011 puts Arabic at the root with **no redirect from `/`**, because the
 * product is Arabic-first and sending every Saudi visitor through a redirect to
 * reach the default language is a tax on the majority for the convenience of
 * routing. `localePrefix: 'as-needed'` is exactly that: `/pricing` is Arabic,
 * `/en/pricing` is English.
 *
 * It also means **every route that existed before this milestone still answers
 * at the address it always had**. `/builder/{id}`, `/dashboard/…` and the API
 * are untouched; English is additive. A locale prefix on the default would have
 * moved live URLs, which is not something a translation milestone gets to do.
 *
 * ## What is deliberately outside this
 *
 *   • **`/i/{slug}`** — an invitation's language belongs to the *invitation*,
 *     not to the visitor. An Arabic invitation is Arabic for a guest in London.
 *     Under `[locale]` the same wedding would have two addresses (`/ar/i/x` and
 *     `/en/i/x`), which is an SEO error and, worse, an unanswerable question
 *     when someone asks which link to send (ADR-0011 §2).
 *   • **`/api/…`** — machine surfaces. A JSON error code is not translated
 *     copy; the client decides how to say it.
 *   • **`/admin`** — an internal console read by the people who operate it.
 */

export const LOCALES = ['ar', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ar';

/** Which way each locale is written. Used for `dir` and for the type checker. */
export const LOCALE_DIRECTION: Readonly<Record<Locale, 'rtl' | 'ltr'>> = {
  ar: 'rtl',
  en: 'ltr',
};

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  /**
   * The visitor's `Accept-Language` does not choose for them.
   *
   * Automatic detection would send an English-configured phone — which is a
   * great many phones in the Gulf — to the English site by default, when the
   * person holding it reads Arabic and the product is Arabic-first. The
   * language follows the URL, and the URL follows an explicit choice.
   */
  localeDetection: false,
});

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
