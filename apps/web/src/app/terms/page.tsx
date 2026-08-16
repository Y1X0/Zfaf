import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import { SiteShell } from '../SiteShell.js';

/**
 * Terms of use (D9.5).
 *
 * Both languages are the *same* document, not a summary and a full text. A
 * legal page that says less in Arabic than in English on an Arabic-first
 * product would be indefensible, and it is the kind of asymmetry that creeps in
 * when one language is translated from the other as an afterthought.
 *
 * The date is a constant rather than `new Date()`: "last updated" must mean the
 * day the wording changed, and a page that renews its own timestamp on every
 * deploy is telling the reader something false.
 */
const LAST_UPDATED = '2026-08-16';

const SECTIONS = ['s1', 's2', 's3', 's4', 's5', 's6'] as const;

export default function TermsPage(): ReactElement {
  const t = useTranslations('legal.terms');
  const legal = useTranslations('legal');

  return (
    <SiteShell>
      <article className="zf-prose zf-legal">
        <h1>{t('title')}</h1>
        <p className="zf-legal__updated">{legal('updated', { date: LAST_UPDATED })}</p>
        <p>{t('intro')}</p>
        {SECTIONS.map((key) => (
          <section key={key}>
            <h2>{t(`${key}.title`)}</h2>
            <p>{t(`${key}.body`)}</p>
          </section>
        ))}
      </article>
    </SiteShell>
  );
}
