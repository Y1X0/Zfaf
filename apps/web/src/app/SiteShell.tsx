import type { ReactElement, ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import Link from 'next/link';

/**
 * The header and footer around every public page (D9.4, D9.6).
 *
 * A server component with no client JavaScript. Navigation is `<a>` elements,
 * the language switch is a link, and the whole marketing surface works with
 * scripting disabled — which is not an accessibility flourish, it is what
 * keeps `/` within its 120 KB budget while carrying a font.
 *
 * Two accessibility decisions that are easy to leave out and expensive to add
 * later: a skip link as the first focusable element, so a keyboard user is not
 * made to tab through the whole navigation on every page; and `aria-current`
 * on the language switch's destination rather than a colour change, so the
 * state is announced and not merely seen.
 */
export function SiteShell({ children }: { children: ReactNode }): ReactElement {
  const t = useTranslations('nav');
  const common = useTranslations('common');

  return (
    <div className="zf-site">
      <a className="zf-skip" href="#main">
        {common('skipToContent')}
      </a>

      <header className="zf-header">
        <div className="zf-header__inner">
          <Link className="zf-brand" href="/">
            {common('brand')}
          </Link>
          <nav className="zf-nav" aria-label={t('home')}>
            <Link href="/templates">{t('templates')}</Link>
            <Link href="/pricing">{t('pricing')}</Link>
            <Link href="/faq">{t('faq')}</Link>
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
            <Link href="/terms">{t('terms')}</Link>
            <Link href="/privacy">{t('privacy')}</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
