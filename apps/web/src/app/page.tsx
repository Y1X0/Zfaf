import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import Link from 'next/link';
import { SiteShell } from './SiteShell.js';

/**
 * The home page (D9.4).
 *
 * Server-rendered, no client island, no carousel and no animation library. The
 * budget for this route is 120 KB of JavaScript (docs/07 §10) and almost all of
 * it is already spent by the App Router runtime before we write a line — so
 * what is here is text, links and a font.
 *
 * The four claims below are the four the product can actually keep, and each is
 * checked somewhere in the test suite rather than being copy: it opens
 * instantly (Lighthouse on `/i/{slug}`), it is Arabic-first (the RTL suite),
 * guests reply without an account (the RSVP suite), and we set no cookies —
 * which the analytics suite reads out of a real browser.
 */
export default function HomePage(): ReactElement {
  const t = useTranslations('marketing');

  return (
    <SiteShell>
      <section className="zf-hero">
        <h1>{t('hero.title')}</h1>
        <p>{t('hero.subtitle')}</p>
        <div className="zf-cta">
          <Link className="zf-btn" href="/pricing">
            {t('hero.cta')}
          </Link>
          <Link className="zf-btn zf-btn--quiet" href="/templates">
            {t('hero.secondary')}
          </Link>
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
