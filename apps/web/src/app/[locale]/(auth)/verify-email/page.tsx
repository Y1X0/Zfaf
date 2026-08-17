import type { ReactElement } from 'react';

import { VerifyEmailPanel } from '../../../../auth/AuthForms.js';
import { IslandMessages } from '../../../../i18n/island.js';
import { DEFAULT_LOCALE, type Locale, isLocale } from '../../../../i18n/routing.js';
import { AuthCard } from '../AuthCard.js';
import '../../../auth.css';

/**
 * Where the verification email points (FR-A2, docs/23 §7.1).
 *
 * The email links **here**, and this page posts the token to the endpoint. It
 * must not be the other way round: docs/09 §5 forbids a mutating `GET`, and a
 * link in an inbox is followed by mail scanners, corporate proxies and link
 * previewers — every one of which would consume a single-use token before the
 * person ever clicked.
 *
 * `force-dynamic` because the answer depends entirely on a query parameter
 * that is different for every visitor; a cached rendering of this page would
 * be a cached rendering of somebody else's token.
 */
export const dynamic = 'force-dynamic';

export default async function VerifyEmailPage({
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
  // A repeated parameter arrives as an array. Taking the first rather than
  // joining them: `?token=a&token=b` is a malformed link, not two tokens.
  const token = Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

  return (
    <AuthCard locale={locale} titleKey="verify.title">
      <IslandMessages namespaces={['auth', 'common']}>
        <VerifyEmailPanel token={token} />
      </IslandMessages>
    </AuthCard>
  );
}
