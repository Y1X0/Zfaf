import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';

import { activeMarkets, getMarket } from '@zfaf/core';

import { DEFAULT_LOCALE, routing } from './routing.js';

/**
 * Loads the message catalogue for a request (D9.1).
 *
 * Both catalogues are imported statically rather than through a computed
 * `import(\`./messages/${locale}.json\`)`. Two reasons, and the second is the
 * one that matters: a dynamic specifier defeats the bundler's tracing, so the
 * standalone output can ship without the JSON and fail in production while
 * working perfectly in development — the same class of failure the Amiri font
 * hit in M6. It is also the shape the "no dynamic evaluation" guardrail
 * accepts, and for the same underlying reason.
 *
 * Two locales of a few kilobytes each do not need lazy loading.
 */
import ar from './messages/ar.json' with { type: 'json' };
import en from './messages/en.json' with { type: 'json' };

const CATALOGUES = { ar, en } as const;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  /**
   * An unrecognised locale falls back to Arabic rather than throwing.
   *
   * The `[locale]` layout already answers 404 for a wrong prefix, so by the
   * time this runs the value is either valid or absent — absent on the
   * surfaces deliberately outside locale routing (`/admin`, and the
   * `/_not-found` page Next prerenders with no segment of its own).
   */
  const locale = hasLocale(routing.locales, requested) ? requested : DEFAULT_LOCALE;

  return {
    locale,
    messages: CATALOGUES[locale],
    /**
     * One zone for every formatted date and number in the product UI.
     *
     * Without it, a date formatted on the server uses the server's zone and
     * the same one formatted in the browser uses the visitor's, so a timestamp
     * shifts the moment React hydrates.
     *
     * The value comes from the configured market rather than from a literal —
     * a hard-coded `Asia/Riyadh` here would be the assumption ADR-0015 exists
     * to remove, and the `zfaf/no-market-literals` rule refuses it outright.
     * An invitation's *own* events are formatted in the invitation's zone
     * instead: that is content, and it travels in the snapshot (ADR-0011 §4).
     */
    timeZone: uiTimeZone(),
    onError(error) {
      /**
       * A missing key is logged, never thrown.
       *
       * next-intl's default is to throw in development, which turns one
       * untranslated string into a blank screen. The catalogue is checked
       * exhaustively in CI instead (`scripts/check-i18n.mjs`), which is where a
       * missing key should be caught — before it reaches anyone, rather than by
       * taking a page down in front of them.
       */
      console.warn(`[i18n] ${error.message}`);
    },
  };
});

/**
 * The zone the product's own interface formats in.
 *
 * Read from the configured market rather than written as a literal — a
 * hard-coded `Asia/Riyadh` would be exactly the assumption ADR-0015 exists to
 * remove, and `zfaf/no-market-literals` refuses it outright.
 *
 * It reads `process.env` directly rather than going through `getEnv()`, and
 * that is deliberate: `getEnv()` validates the *whole* environment, including
 * the session secret and the storage credentials. This module is evaluated
 * while Next prerenders the static pages, so calling it would make a build
 * require production secrets — and a build that cannot run without them is a
 * build nobody can run in CI. An unset or unknown code falls back to the first
 * configured market, which is a real market with a real zone.
 */
function uiTimeZone(): string {
  const configured = process.env['DEFAULT_MARKET'];
  const market = (configured ? getMarket(configured) : undefined) ?? activeMarkets()[0];
  return market?.defaultTimezone ?? 'UTC';
}
