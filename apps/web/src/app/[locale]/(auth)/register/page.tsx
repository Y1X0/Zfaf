import type { ReactElement } from 'react';

import { RegisterForm } from '../../../../auth/AuthForms.js';
import { IslandMessages } from '../../../../i18n/island.js';
import { DEFAULT_LOCALE, type Locale, isLocale } from '../../../../i18n/routing.js';
import { AuthCard } from '../AuthCard.js';
import '../../../auth.css';

/**
 * Creating an account (FR-A1, docs/23 §7.1).
 *
 * The page's locale is passed into the form and sent with the registration,
 * so the verification email arrives in the language the person was reading —
 * not the one their phone happens to be configured in (ADR-0011).
 */
export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return (
    <AuthCard
      locale={locale}
      titleKey="register.title"
      ledeKey="register.lede"
      alt={{ textKey: 'register.haveAccount', linkKey: 'login.title', href: '/login' }}
    >
      <IslandMessages namespaces={['auth', 'common']}>
        <RegisterForm locale={locale} />
      </IslandMessages>
    </AuthCard>
  );
}
