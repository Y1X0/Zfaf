import type { ReactElement } from 'react';

import { ForgotPasswordForm } from '../../../../auth/AuthForms.js';
import { IslandMessages } from '../../../../i18n/island.js';
import { DEFAULT_LOCALE, type Locale, isLocale } from '../../../../i18n/routing.js';
import { AuthCard } from '../AuthCard.js';
import '../../../auth.css';

/**
 * Asking for a reset link (FR-A3, docs/23 §7.1).
 *
 * The lede says a link is on its way *if that address has an account*, and the
 * form renders the same confirmation either way. Anything else would make this
 * page a service for discovering which addresses are registered — which is
 * exactly what the endpoint refuses to be.
 */
export default async function ForgotPasswordPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return (
    <AuthCard
      locale={locale}
      titleKey="forgot.title"
      ledeKey="forgot.lede"
      alt={{ textKey: 'forgot.remembered', linkKey: 'login.title', href: '/login' }}
    >
      <IslandMessages namespaces={['auth', 'common']}>
        <ForgotPasswordForm />
      </IslandMessages>
    </AuthCard>
  );
}
