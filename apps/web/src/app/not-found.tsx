import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import Link from 'next/link';

/**
 * 404 inside the localised site (D9.7).
 *
 * Two of the four error pages are already elsewhere and deliberately so: 410
 * and 451 belong to `/i/{slug}`, which serves its own zero-hydration document
 * (ADR-0020) and must not pull the App Router runtime in to say "this
 * invitation has ended". Those live in `public-page/UnavailableDocument.tsx`.
 *
 * This one covers a mistyped marketing or dashboard URL, and it offers a way
 * out rather than only stating the problem.
 */
export default function NotFound(): ReactElement {
  const t = useTranslations('errors.notFound');

  return (
    <div className="zf-error" data-testid="error-not-found">
      <h1>{t('title')}</h1>
      <p>{t('body')}</p>
      <p>
        <Link className="zf-btn" href="/">
          {t('action')}
        </Link>
      </p>
    </div>
  );
}
