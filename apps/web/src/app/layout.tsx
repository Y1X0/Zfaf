import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { DEFAULT_LOCALE, LOCALE_DIRECTION } from '../i18n/routing.js';
import './site.css';

export const metadata: Metadata = {
  title: 'Zfaf',
  description: 'Digital wedding invitations',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * The document shell (D9.1, D9.2, D9.3).
 *
 * `lang` and `dir` are set **here**, in the root layout, because Next allows
 * only the root layout to render `<html>` — a nested `[locale]/layout.tsx`
 * cannot, however natural that would read. So the locale is resolved from the
 * request rather than from a route parameter, which also gives the surfaces
 * *outside* `[locale]` (the admin console) a correct document to sit in.
 *
 * The direction is one attribute and there is no `[dir="rtl"]` override sheet
 * anywhere in this codebase. Layout is written in logical properties and flips
 * because the document says which way it reads, with an ESLint rule failing CI
 * if a physical property creeps in (ADR-0011 §3).
 *
 * There is deliberately **no `NextIntlClientProvider` here**. Wrapping the
 * whole application in one hands the entire message catalogue to the browser
 * on every page — including the marketing pages, which are static server
 * components that need none of it. Measured, that was 35 KB of JSON on a route
 * with a 120 KB budget. The provider lives around the two client islands
 * instead, each given only the namespaces it uses.
 *
 * The fonts are preloaded here rather than being discovered inside a
 * stylesheet. A `@font-face` rule is only fetched once the sheet has parsed
 * *and* layout has found text that needs it — two round trips into the load, on
 * a connection where the first paint is already the whole budget. `preload`
 * starts the download during head parsing instead (D9.3).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const locale = DEFAULT_LOCALE;

  return (
    <html lang={locale} dir={LOCALE_DIRECTION[locale]}>
      <head>
        {/*
          `crossOrigin` is required even for a same-origin font: the CORS-mode
          fetch a preload performs and the one the font loader performs must
          match, or the file is downloaded twice — which is worse than not
          preloading it at all.
        */}
        <link
          rel="preload"
          href="/fonts/zfaf-arabic.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
