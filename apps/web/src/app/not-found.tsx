import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

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
 *
 * It sits at the **root** of the app directory, not under `[locale]`. Next
 * uses a segment's `not-found` only for an explicit `notFound()` call inside
 * that segment; a URL that matches no route at all falls through to the root
 * one. With it under `[locale]`, a mistyped `/pricingg` got Next's own
 * untranslated 404 — a gap that passes a status-code check and is wrong to the
 * person reading it.
 *
 * The language still comes out right: the root layout resolves the locale from
 * the request, so `/en/pricingg` is answered in English.
 */
export default function NotFound(): ReactElement {
  const t = useTranslations('errors.notFound');

  return (
    <div className="zf-error" data-testid="error-not-found">
      <h1>{t('title')}</h1>
      <p>{t('body')}</p>
      <p>
        {/* A plain anchor: this page must work with no client runtime at all. */}
        <a className="zf-btn" href="/">
          {t('action')}
        </a>
      </p>
    </div>
  );
}
