import type { ReactElement, ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

import { localePath } from '../../../i18n/href.js';
import type { Locale } from '../../../i18n/routing.js';

/**
 * The frame around every auth form (docs/23 §7.1).
 *
 * A server component with no client JavaScript of its own. The heading, the
 * lede and the link to the other form are text, and the only interactive part
 * of these pages is the form island inside — which is why the provider wraps
 * *that* rather than the page (D9.1, ADR-0021).
 */
export async function AuthCard({
  locale,
  titleKey,
  ledeKey,
  alt,
  children,
}: {
  readonly locale: Locale;
  readonly titleKey: string;
  readonly ledeKey?: string;
  /** The other door: "no account yet?", "remembered it after all?". */
  readonly alt?: { readonly textKey: string; readonly linkKey: string; readonly href: string };
  readonly children: ReactNode;
}): Promise<ReactElement> {
  const t = await getTranslations('auth');
  const common = await getTranslations('common');

  return (
    <div className="zfa">
      <div className="zfa__card">
        <a className="zfa__brand" href={localePath(locale, '/')}>
          {common('brand')}
        </a>

        <h1 className="zfa__title">{t(titleKey)}</h1>
        {ledeKey ? <p className="zfa__lede">{t(ledeKey)}</p> : null}

        {children}

        {alt ? (
          <p className="zfa__alt">
            {t(alt.textKey)} <a href={localePath(locale, alt.href)}>{t(alt.linkKey)}</a>
          </p>
        ) : null}
      </div>
    </div>
  );
}
