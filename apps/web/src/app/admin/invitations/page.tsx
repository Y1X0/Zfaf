import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';

import { type AdminInvitationRow, adminListInvitations } from '@zfaf/core';

import { adminAuditor } from '../../../server/admin.js';
import { container } from '../../../server/container.js';
import { requireAdmin } from '../../../server/request-context.js';

/**
 * Invitation browse and search (D8.6).
 *
 * The columns are the ones an incident actually needs: which invitation, whose
 * account, what state it is in, how many people have replied. The reply
 * *count* and never a reply — the repository behind this has no method that
 * could return a guest's name, so the rule holds even if somebody adds a
 * column here later (docs/09 §3.4).
 *
 * A plain `<form method="get">` for the search. There is no client island on
 * this page: it is a list with a filter, opened by a handful of people, and a
 * form the browser submits does the job without shipping anything.
 */

export const dynamic = 'force-dynamic';

export default async function AdminInvitationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const gate = await requireAdmin();
  // Not a redirect to a sign-in page: a 404 is the same answer a stranger gets
  // for any path that is not theirs, and it does not confirm that an admin
  // console lives here.
  if (!gate.ok) notFound();

  const params = await searchParams;
  const query = single(params['q']);
  const status = single(params['status']);

  const result = await adminListInvitations(
    { actor: gate.actor, query, status },
    {
      admin: container().admin,
      clock: container().clock,
      recordAdminAccess: adminAuditor(gate.ipHash),
    },
  );
  if (!result.ok) notFound();

  return (
    <main>
      <form className="zfd-controls" method="get" role="search">
        <label className="zfd-field">
          <span className="zfd-field__label">Search slug, title or owner email</span>
          <input
            className="zfd-field__input"
            type="search"
            name="q"
            defaultValue={query ?? ''}
            data-testid="admin-search"
          />
        </label>
        <button className="zfd-btn" type="submit">
          Search
        </button>
      </form>

      {result.page.rows.length === 0 ? (
        <p className="zfd-empty" data-testid="admin-empty">
          No invitations match.
        </p>
      ) : (
        <div className="zfd-scroll">
          <table className="zfd-table" data-testid="admin-invitations">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Slug</th>
                <th scope="col">Status</th>
                <th scope="col">Owner</th>
                <th scope="col">Replies</th>
                <th scope="col">Event</th>
              </tr>
            </thead>
            <tbody>
              {result.page.rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="zfd-note">
        {result.page.total} total. Guest names and phone numbers are never shown here.
      </p>
    </main>
  );
}

function Row({ row }: { row: AdminInvitationRow }): ReactElement {
  return (
    <tr data-testid="admin-invitation-row">
      <td>{row.title}</td>
      <td>{row.slug ?? '—'}</td>
      <td>
        <span
          className={row.status === 'SUSPENDED' ? 'zfd-tag zfd-tag--suspended' : 'zfd-tag'}
          data-testid="admin-invitation-status"
        >
          {row.status}
        </span>
      </td>
      <td>{row.ownerEmail}</td>
      <td>{row.rsvpCount}</td>
      <td>{row.eventDate}</td>
    </tr>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
