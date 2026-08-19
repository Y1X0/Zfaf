import type { ReactElement } from 'react';
import { getTranslations } from 'next-intl/server';

import { localePath } from '../../../i18n/href.js';
import type { Locale } from '../../../i18n/routing.js';
import { SiteShell } from './SiteShell.js';

/**
 * The home page (D9.4).
 *
 * Server-rendered, no client island, no carousel and no animation library. The
 * budget for this route is 144 KB of JavaScript (ADR-0021) and 138.4 KB of it
 * is already spent by the App Router runtime before we write a line — so what
 * is here is text, links and a font, and our own contribution measures zero.
 *
 * The four claims below are the four the product can actually keep, and each is
 * checked somewhere in the test suite rather than being copy: it opens
 * instantly (Lighthouse on `/i/{slug}`), it is Arabic-first (the RTL suite),
 * guests reply without an account (the RSVP suite), and we set no cookies —
 * which the analytics suite reads out of a real browser.
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const locale = raw as Locale;
  const t = await getTranslations('marketing');

  return (
    <SiteShell locale={locale} path="/">
      <section className="zf-hero">
        <h1>{t('hero.title')}</h1>
        <p>{t('hero.subtitle')}</p>
        <div className="zf-cta">
          <a className="zf-btn" href={localePath(locale, '/register')}>
            {t('hero.cta')}
          </a>
          <a className="zf-btn zf-btn--quiet" href={localePath(locale, '/templates')}>
            {t('hero.secondary')}
          </a>
        </div>
      </section>

      <section aria-labelledby="features">
        <h2 id="features">{t('features.title')}</h2>
        <div className="zf-grid">
          {(['fast', 'arabic', 'rsvp', 'privacy'] as const).map((key) => (
            <article className="zf-card" key={key}>
              <h3>{t(`features.${key}.title`)}</h3>
              <p>{t(`features.${key}.body`)}</p>
            </article>
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
