import type { ReactElement, ReactNode } from 'react';

import '../dashboard.css';

/**
 * The admin console shell (D8.6, D8.7).
 *
 * `noindex, nofollow` in the metadata and `no-store` on every response from
 * the routes underneath. A support tool listing other people's accounts has no
 * business in a search index or a shared cache, and the two together are what
 * stop a screenshot-shaped copy of somebody's customer list living in a
 * browser's back-forward cache on a laptop in a coffee shop.
 *
 * Written left-to-right and in English, unlike the customer-facing pages. The
 * console is an internal tool read by the people who operate it; the product's
 * Arabic-first rule (ADR-0011) is about the people being served, not about the
 * people doing the serving, and pretending otherwise would mean translating a
 * screen nobody outside the company opens.
 */

export const metadata = {
  title: 'Zfaf — admin',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="zfd" dir="ltr" lang="en">
      <div className="zfd__bar">
        <h1 className="zfd__title">Zfaf admin</h1>
      </div>
      <nav className="zfd-tabs" aria-label="Admin sections">
        <a className="zfd-btn" href="/admin/invitations">
          Invitations
        </a>
        <a className="zfd-btn" href="/admin/users">
          Users
        </a>
        <a className="zfd-btn" href="/admin/audit">
          Audit log
        </a>
      </nav>
      {children}
    </div>
  );
}
