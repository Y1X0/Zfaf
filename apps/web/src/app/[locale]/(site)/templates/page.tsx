import type { ReactElement } from 'react';
import { getTranslations } from 'next-intl/server';

import type { Locale } from '../../../../i18n/routing.js';
import { SiteShell } from '../SiteShell.js';

/**
 * The templates page (D9.4).
 *
 * Deliberately a stub with honest copy rather than mock screenshots. The
 * template gallery needs rendered previews of published templates, which is a
 * surface the milestone plan does not build here — and a page of placeholder
 * images is a promise the product has not made yet.
 */
export default async function TemplatesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const t = await getTranslations('marketing.templates');

  return (
    <SiteShell locale={raw as Locale} path="/templates">
      <div className="zf-prose">
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
        <p className="zf-legal__updated">{t('empty')}</p>
      </div>
    </SiteShell>
  );
}
