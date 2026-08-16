import type { ReactElement } from 'react';
import { getTranslations } from 'next-intl/server';

import type { Locale } from '../../../../i18n/routing.js';
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

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const t = await getTranslations('legal.terms');
  const legal = await getTranslations('legal');

  return (
    <SiteShell locale={raw as Locale} path="/terms">
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
