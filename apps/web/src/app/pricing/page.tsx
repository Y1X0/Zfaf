import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import { SiteShell } from '../SiteShell.js';

/**
 * The pricing page (D9.4).
 *
 * No numbers on it, and that is the correct state rather than an omission.
 * Prices are per market and carry that market's tax rules (ADR-0015), the plan
 * catalogue is not seeded, and payments are Phase 2. Printing a figure here
 * would be inventing a commitment no decision has made — so the page says what
 * is true: the pricing model, and that the figures come before launch.
 */
export default function PricingPage(): ReactElement {
  const t = useTranslations('marketing.pricing');

  return (
    <SiteShell>
      <div className="zf-prose">
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
        <p>{t('note')}</p>
        <p className="zf-legal__updated">{t('comingSoon')}</p>
      </div>
    </SiteShell>
  );
}
