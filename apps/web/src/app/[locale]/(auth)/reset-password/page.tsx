import type { ReactElement } from 'react';

import { ResetPasswordForm } from '../../../../auth/AuthForms.js';
import { IslandMessages } from '../../../../i18n/island.js';
import { DEFAULT_LOCALE, type Locale, isLocale } from '../../../../i18n/routing.js';
import { AuthCard } from '../AuthCard.js';
import '../../../auth.css';

/**
 * Choosing a new password (FR-A3, docs/23 §7.1).
 *
 * Succeeding here ends **every** session on the account, this browser's
 * included — so the form sends the person to sign in again rather than
 * pretending they are still where they were. If the reset was triggered by an
 * attacker who already had a session, leaving it alive would defeat the whole
 * exercise.
 */
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  const query = await searchParams;
  const value = query['token'];
  const token = Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

  return (
    <AuthCard locale={locale} titleKey="reset.title" ledeKey="reset.lede">
      <IslandMessages namespaces={['auth', 'common']}>
        <ResetPasswordForm token={token} />
      </IslandMessages>
    </AuthCard>
  );
}
