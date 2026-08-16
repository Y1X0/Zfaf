'use client';

import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

/**
 * The 500 page (D9.7).
 *
 * A client component because Next requires error boundaries to be one — this
 * is the single place in the localised site where that is not a choice.
 *
 * It shows the visitor nothing about what broke. `error.message` on this page
 * would put a stack-adjacent string in front of whoever hit the failure, and
 * the useful version of it belongs in the server log, which is where the
 * effect below sends the digest. "This is our problem, not yours" is the whole
 * message a person needs.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactElement {
  const t = useTranslations('errors.server');

  useEffect(() => {
    // The digest is the only handle that ties this page to the server-side
    // trace; the message itself is deliberately not rendered.
    console.error(`[error] ${error.digest ?? 'no digest'}`);
  }, [error]);

  return (
    <div className="zf-error" data-testid="error-server">
      <h1>{t('title')}</h1>
      <p>{t('body')}</p>
      <p>
        <button className="zf-btn" type="button" onClick={reset}>
          {t('action')}
        </button>
      </p>
    </div>
  );
}
