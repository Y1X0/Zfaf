import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { FREE_BETA_PLAN, customerScopeFor, resolveEntitlements } from '@zfaf/core';

import { SignOutButton } from '../../../../auth/AuthForms.js';
import { DeleteInvitationButton } from '../../../../dashboard/DeleteInvitationButton.js';
import { NewInvitation, type TemplateChoice } from '../../../../dashboard/NewInvitation.js';
import { localePath } from '../../../../i18n/href.js';
import { IslandMessages } from '../../../../i18n/island.js';
import { DEFAULT_LOCALE, type Locale, isLocale } from '../../../../i18n/routing.js';
import { container } from '../../../../server/container.js';
import { requireActor } from '../../../../server/request-context.js';
import '../../../dashboard.css';
import '../../../auth.css';

/**
 * The dashboard (docs/23 §7.4).
 *
 * The page a customer lands on after signing in, and the one thing the product
 * had no way to show: the invitations were there, the builder was there, and
 * nothing listed them or let anyone start one.
 *
 * It is a **server** page. The list is small, it is read far more often than it
 * changes, and rendering it on the server means the whole thing arrives as
 * HTML — the two islands are the create form and the sign-out button, which
 * are the only parts that need to do anything.
 *
 * ## Two decisions worth naming
 *
 * **`customerScopeFor`, not `tenantScopeFor`.** Staff carry `ownerId: null`,
 * which every repository reads as "no owner constraint" — the obvious spelling
 * would have shown a staff session every tenant's invitations on a page with
 * none of the admin console's protections.
 *
 * **A redirect to `/login`, not a 404.** An anonymous visitor at `/dashboard`
 * has almost certainly just had their session expire, and hiding the page from
 * them protects nothing: the address is in the footer of every email we send.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ReactElement> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  const session = await requireActor();
  if (!session.authenticated) redirect(localePath(locale, '/login'));

  const scope = customerScopeFor(session.actor);
  // A staff session that reached here is signed in as an operator, not as a
  // customer. The console is where their work is.
  if (!scope) redirect('/admin');

  const deps = container();
  const t = await getTranslations('dashboard');

  const [invitations, published] = await Promise.all([
    deps.invitations.listInScope(scope),
    deps.templates.listPublished(),
  ]);

  /**
   * Which templates this customer may actually start from.
   *
   * Compared by **level**, never by plan name (ADR-0014). A locked template is
   * listed and marked rather than hidden — somebody choosing between three
   * designs should know the fourth exists.
   */
  const entitlements = resolveEntitlements(FREE_BETA_PLAN, [], deps.clock.now());
  const templates: TemplateChoice[] = published.map((template) => ({
    key: template.manifest.key,
    name: template.manifest.meta.name[locale] ?? template.manifest.key,
    locked: template.manifest.meta.requiredPlanLevel > entitlements.planLevel(),
  }));

  return (
    <div className="zfd">
      <div className="zfd__bar">
        <h1 className="zfd__title">{t('title')}</h1>
        <IslandMessages namespaces={['auth', 'common']}>
          <SignOutButton />
        </IslandMessages>
      </div>

      {/* The verification notice, and only when it is true. Verification gates
          publishing rather than the first run (FR-A2), so this is information
          rather than a wall — the builder is reachable either way. */}
      {session.actor.kind === 'user' && !session.actor.emailVerified ? (
        <p className="zfa-ok" role="status" data-testid="verify-notice">
          {t('verifyNotice')}
        </p>
      ) : null}

      <IslandMessages namespaces={['dashboard', 'common']}>
        <NewInvitation templates={templates} defaultLocale={locale} />
      </IslandMessages>

      {invitations.length === 0 ? (
        <p className="zfd-empty" data-testid="dashboard-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="zfd-list" data-testid="invitation-list">
          {invitations.map((invitation) => (
            <li className="zfd-row" key={invitation.id} data-testid="invitation-row">
              <div className="zfd-row__main">
                <span className="zfd-row__name">{invitation.title}</span>
                <span className="zfd-tag" data-status={invitation.status}>
                  {t(`status.${invitation.status}`)}
                </span>
              </div>

              <p className="zfd-row__meta">{invitation.eventDate}</p>

              <div className="zfd-filters">
                <a
                  className="zfd-btn"
                  href={`/builder/${invitation.id}`}
                  data-testid="open-builder"
                >
                  {t('open')}
                </a>
                <a
                  className="zfd-btn zfd-btn--quiet"
                  href={localePath(locale, `/dashboard/invitations/${invitation.id}/rsvps`)}
                >
                  {t('replies')}
                </a>
                {/* Only once there is something to look at. A link to a page
                    that says "not published yet" is a wasted tap. */}
                {invitation.slug && invitation.status === 'PUBLISHED' ? (
                  <a className="zfd-btn zfd-btn--quiet" href={`/i/${invitation.slug}`}>
                    {t('view')}
                  </a>
                ) : null}
                <IslandMessages namespaces={['dashboard']}>
                  <DeleteInvitationButton invitationId={invitation.id} />
                </IslandMessages>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
