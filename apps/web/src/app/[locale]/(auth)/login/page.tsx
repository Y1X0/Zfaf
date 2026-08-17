import type { ReactElement } from 'react';
import { getTranslations } from 'next-intl/server';

import { LoginForm } from '../../../../auth/AuthForms.js';
import { localePath } from '../../../../i18n/href.js';
import { IslandMessages } from '../../../../i18n/island.js';
import { DEFAULT_LOCALE, type Locale, isLocale } from '../../../../i18n/routing.js';
import { AuthCard } from '../AuthCard.js';
import '../../../auth.css';

/** Signing in (FR-A1, docs/23 §7.1). */
export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const t = await getTranslations('auth');

  return (
    <AuthCard
      locale={locale}
      titleKey="login.title"
      ledeKey="login.lede"
      alt={{ textKey: 'login.noAccount', linkKey: 'register.title', href: '/register' }}
    >
      <IslandMessages namespaces={['auth', 'common']}>
        <LoginForm />
      </IslandMessages>

      {/* Above the "no account yet?" line, because somebody who cannot get in
          is far more often a customer who forgot than a stranger signing up. */}
      <p className="zfa__alt">
        <a href={localePath(locale, '/forgot-password')}>{t('login.forgot')}</a>
      </p>
    </AuthCard>
  );
}
