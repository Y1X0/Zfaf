import type { ReactElement, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

/**
 * Hands a client island only the messages it uses (D9.1).
 *
 * `NextIntlClientProvider` with no `messages` prop serialises the **whole**
 * catalogue into the page. On the builder that is merely wasteful; on a
 * marketing page it is 35 KB of JSON that no component reads, on a route with a
 * 120 KB budget. So the provider is not at the root — it wraps each island, and
 * each island names its namespaces.
 *
 * Server components do not need this at all: `useTranslations` reads the
 * catalogue on the server, where it already is.
 */
export async function IslandMessages({
  namespaces,
  children,
}: {
  readonly namespaces: readonly string[];
  readonly children: ReactNode;
}): Promise<ReactElement> {
  const [locale, all] = await Promise.all([
    getLocale(),
    getMessages() as Promise<Record<string, unknown>>,
  ]);
  const picked: Record<string, unknown> = {};
  for (const namespace of namespaces) {
    if (namespace in all) picked[namespace] = all[namespace];
  }

  /**
   * `locale` is passed explicitly.
   *
   * The provider can inherit it from the server context, but only when it is
   * rendered directly in the request's React tree — and this one sits inside a
   * shared component that is also reached during static generation, where the
   * inherited value is not there to read. Passing it makes the boundary
   * self-contained instead of dependent on where it happens to be mounted.
   */
  return (
    <NextIntlClientProvider locale={locale} messages={picked}>
      {children}
    </NextIntlClientProvider>
  );
}
