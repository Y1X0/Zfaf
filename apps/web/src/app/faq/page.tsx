import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

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

export default function FaqPage(): ReactElement {
  const t = useTranslations('marketing.faq');

  return (
    <SiteShell>
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
