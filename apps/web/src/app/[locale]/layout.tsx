import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';

import { routing } from '../../i18n/routing.js';

/**
 * The locale segment (D9.1).
 *
 * `lang` and `dir` are not set here — only a root layout may render `<html>`,
 * so it resolves the locale from the request and sets them there. What this
 * layout does is narrower and still necessary:
 *
 *   • **Rejects an unknown locale.** `/fr/pricing` is a 404 rather than a
 *     silent fallback to Arabic. Serving the default under a wrong prefix is a
 *     soft 404, which search engines and people both find worse than an honest
 *     one.
 *   • **Pins the locale before anything renders.** Without `setRequestLocale`
 *     every page below becomes dynamic, because next-intl would have to read
 *     the locale from a request header it cannot see while generating
 *     statically.
 *
 * There is deliberately **no `NextIntlClientProvider` here**. The provider is
 * itself a client component, and one anywhere in the tree pulls React's whole
 * client runtime into pages made of text — measured at 151 KB against the
 * 144 KB budget ADR-0021 sets from the measured framework floor. The marketing and legal pages use plain `<a>` elements and
 * server-side translation, so they need no context at all; the genuinely
 * interactive islands get their own provider, with only their own namespaces,
 * through `IslandMessages`.
 */

export function generateStaticParams(): { locale: string }[] {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  setRequestLocale(locale);

  return <>{children}</>;
}
