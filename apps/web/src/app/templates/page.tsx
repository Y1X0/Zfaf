import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import { SiteShell } from '../SiteShell.js';

/**
 * The templates page (D9.4).
 *
 * Deliberately a stub with honest copy rather than mock screenshots. The
 * template gallery needs rendered previews of published templates, which is a
 * surface the milestone plan does not build here — and a page of placeholder
 * images is a promise the product has not made yet.
 */
export default function TemplatesPage(): ReactElement {
  const t = useTranslations('marketing.templates');

  return (
    <SiteShell>
      <div className="zf-prose">
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
        <p className="zf-legal__updated">{t('empty')}</p>
      </div>
    </SiteShell>
  );
}
