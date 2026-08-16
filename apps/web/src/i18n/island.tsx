import type { ReactElement, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

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
  const all = (await getMessages()) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const namespace of namespaces) {
    if (namespace in all) picked[namespace] = all[namespace];
  }

  return <NextIntlClientProvider messages={picked}>{children}</NextIntlClientProvider>;
}
