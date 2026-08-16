import type { ReactElement } from 'react';
import { getTranslations } from 'next-intl/server';

import type { Locale } from '../../../../i18n/routing.js';
import { SiteShell } from '../SiteShell.js';

/**
 * Frequently asked questions (D9.4).
 *
 * Native `<details>` elements: keyboard operable, announced correctly by a
 * screen reader, and functional with scripting off — none of which a
 * hand-rolled accordion gets without work.
 *
 * The answers are the honest ones. "Who can see my invitation?" says plainly
 * that a link is not a password, which is the same sentence ADR-0017 requires
 * on the publish panel and the invitation itself. Three places, one truth.
 */
const QUESTIONS = ['q1', 'q2', 'q3', 'q4', 'q5'] as const;

export default async function FaqPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const t = await getTranslations('marketing.faq');

  return (
    <SiteShell locale={raw as Locale} path="/faq">
      <div className="zf-prose zf-faq">
        <h1>{t('title')}</h1>
        {QUESTIONS.map((key) => (
          <details key={key} data-testid="faq-item">
            <summary>{t(`${key}.q`)}</summary>
            <p>{t(`${key}.a`)}</p>
          </details>
        ))}
      </div>
    </SiteShell>
  );
}
