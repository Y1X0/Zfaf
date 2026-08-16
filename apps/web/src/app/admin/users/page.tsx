import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';

import { type AdminUserRow, adminListUsers } from '@zfaf/core';

import { adminAuditor } from '../../../server/admin.js';
import { container } from '../../../server/container.js';
import { requireAdmin } from '../../../server/request-context.js';

/**
 * Account browse and search (D8.6).
 *
 * Read-only, and read-only all the way down: there is no suspend control here
 * because there is no endpoint behind it. `admin:suspend_user` exists in the
 * permission table and building it is not in M8's scope — a button that half
 * works is worse than no button.
 *
 * Opening this page writes an audit entry naming the operator and the search
 * term. That is the point rather than a side effect: "who looked up this
 * customer, and when" is the question a privacy complaint turns on, and it is
 * unanswerable after the fact unless it was written down at the time.
 */

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const gate = await requireAdmin();
  if (!gate.ok) notFound();

  const params = await searchParams;
  const query = single(params['q']);
  const status = single(params['status']);

  const result = await adminListUsers(
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
          <span className="zfd-field__label">Search name or email</span>
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
          No accounts match.
        </p>
      ) : (
        <div className="zfd-scroll">
          <table className="zfd-table" data-testid="admin-users">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Verified</th>
                <th scope="col">Invitations</th>
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

      <p className="zfd-note">{result.page.total} total. This view is read-only.</p>
    </main>
  );
}

function Row({ row }: { row: AdminUserRow }): ReactElement {
  return (
    <tr data-testid="admin-user-row">
      <td>{row.email}</td>
      <td>{row.name ?? '—'}</td>
      <td>{row.role}</td>
      <td>
        <span className={row.status === 'suspended' ? 'zfd-tag zfd-tag--suspended' : 'zfd-tag'}>
          {row.status}
        </span>
      </td>
      <td>{row.emailVerified ? 'yes' : 'no'}</td>
      <td>{row.invitationCount}</td>
    </tr>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
