import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import { SiteShell } from '../SiteShell.js';

/**
 * The privacy policy (D9.5).
 *
 * Every claim on this page is one the code actually enforces, and each is
 * checked by a test somewhere:
 *
 *   • *staff cannot read guest data* — no code path in the repository can
 *     produce a guest's name for a staff actor, proved at the repository and
 *     HTTP levels (M7);
 *   • *no cookies on the invitation page* — read out of a real browser after
 *     the script has run (M8);
 *   • *no IP address stored* — asserted against every column of
 *     `analytics_events`, and against the schema itself (M8);
 *   • *the daily key is never persisted* — checked against every table in the
 *     database (M8).
 *
 * That is the only reason this page is allowed to say them. A privacy policy
 * that describes intentions rather than mechanisms is a liability, not a
 * disclosure.
 */
const LAST_UPDATED = '2026-08-16';

const SECTIONS = ['s1', 's2', 's3', 's4', 's5', 's6'] as const;

export default function PrivacyPage(): ReactElement {
  const t = useTranslations('legal.privacy');
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
        <section>
          <h2>{t('s7.title')}</h2>
          {/*
            The address is wrapped in `<bdi>`: a Latin email inside Arabic text
            is bidirectional content, and without isolation the trailing
            punctuation of the sentence jumps to the wrong side of it
            (ADR-0011 §3).
          */}
          <p>
            {t.rich('s7.body', {
              email: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            })}
          </p>
        </section>
      </article>
    </SiteShell>
  );
}
