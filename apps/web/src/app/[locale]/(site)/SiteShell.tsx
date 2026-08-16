import type { ReactElement, ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { localePath, otherLocalePath } from '../../../i18n/href.js';
import type { Locale } from '../../../i18n/routing.js';

/**
 * The header and footer around every public page (D9.4, D9.6).
 *
 * A server component with **no client JavaScript at all**, and that is the
 * whole design rather than an aspiration. Every link is a plain `<a>`; there
 * is no router, no island, and no provider. next-intl's `Link` and a
 * client-side language switch would each pull React's client runtime onto a
 * page made of text — measured at 157 KB against a 144 KB budget (ADR-0021),
 * versus 8 KB
 * without them.
 *
 * The current path arrives as a prop because Next does not give a Server
 * Component its own pathname, and every page already knows what it is. That is
 * cheaper and more honest than a header set in middleware, and it is what lets
 * the language switch point at *this* page in the other language rather than
 * dumping the reader back on the home page.
 *
 * Two accessibility decisions that are easy to omit and expensive to add
 * later: a skip link as the first focusable element, so a keyboard user is not
 * made to tab the whole navigation on every page; and `lang`/`dir` on the
 * language switch, so the word in the other script is announced and laid out
 * as that script rather than inheriting the document's direction.
 */
export function SiteShell({
  locale,
  path,
  children,
}: {
  readonly locale: Locale;
  /** This page's locale-independent path, e.g. `/pricing`. */
  readonly path: string;
  readonly children: ReactNode;
}): ReactElement {
  const t = useTranslations('nav');
  const common = useTranslations('common');

  const href = (target: string): string => localePath(locale, target);
  const other: Locale = locale === 'ar' ? 'en' : 'ar';

  return (
    <div className="zf-site">
      <a className="zf-skip" href="#main">
        {common('skipToContent')}
      </a>

      <header className="zf-header">
        <div className="zf-header__inner">
          <a className="zf-brand" href={href('/')}>
            {common('brand')}
          </a>
          <nav className="zf-nav" aria-label={t('home')}>
            <a href={href('/templates')}>{t('templates')}</a>
            <a href={href('/pricing')}>{t('pricing')}</a>
            <a href={href('/faq')}>{t('faq')}</a>
            <a
              href={otherLocalePath(locale, localePath(locale, path))}
              data-testid="language-switch"
              lang={other}
              dir={other === 'ar' ? 'rtl' : 'ltr'}
            >
              {common('languageSwitch')}
            </a>
          </nav>
        </div>
      </header>

      <main className="zf-main" id="main">
        <div className="zf-container">{children}</div>
      </main>

      <footer className="zf-footer">
        <div className="zf-footer__inner">
          <span>{common('tagline')}</span>
          <nav className="zf-nav" aria-label={t('terms')}>
            <a href={href('/terms')}>{t('terms')}</a>
            <a href={href('/privacy')}>{t('privacy')}</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
