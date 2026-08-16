import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';

import { type AdminAuditRow, adminListAuditLog } from '@zfaf/core';

import { adminAuditor } from '../../../server/admin.js';
import { container } from '../../../server/container.js';
import { requireAdmin } from '../../../server/request-context.js';

/**
 * The audit viewer (D8.7).
 *
 * Restricted more tightly than the other two admin screens: `support` can
 * browse accounts and invitations, but reading the record of what operators
 * did is `admin` and above. That is where a support agent's own actions are
 * written, and the two questions are different.
 *
 * The table is append-only in the database, enforced by a trigger from M1 —
 * there is no route anywhere that updates or deletes a row, and there could
 * not be one that worked. `metadata` is rendered as text rather than parsed
 * into fields, because it is written by a dozen different call sites and a
 * viewer that assumed a shape would quietly stop showing the entries that did
 * not match it.
 */

export const dynamic = 'force-dynamic';

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const gate = await requireAdmin();
  if (!gate.ok) notFound();

  const params = await searchParams;
  const action = single(params['action']);

  const result = await adminListAuditLog(
    { actor: gate.actor, action, limit: 50 },
    {
      admin: container().admin,
      clock: container().clock,
      recordAdminAccess: adminAuditor(gate.ipHash),
    },
  );
  // A `support` operator reaches this line and stops here — the gate let them
  // into the console, the permission refuses this screen.
  if (!result.ok) notFound();

  return (
    <main>
      <form className="zfd-controls" method="get" role="search">
        <label className="zfd-field">
          <span className="zfd-field__label">Filter by action</span>
          <input
            className="zfd-field__input"
            type="search"
            name="action"
            placeholder="invitation.suspend"
            defaultValue={action ?? ''}
            data-testid="admin-search"
          />
        </label>
        <button className="zfd-btn" type="submit">
          Filter
        </button>
      </form>

      {result.page.rows.length === 0 ? (
        <p className="zfd-empty" data-testid="admin-empty">
          No entries match.
        </p>
      ) : (
        <div className="zfd-scroll">
          <table className="zfd-table" data-testid="admin-audit">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Resource</th>
                <th scope="col">Detail</th>
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
        {result.page.total} total. This log is append-only; nothing here can be edited or removed.
      </p>
    </main>
  );
}

function Row({ row }: { row: AdminAuditRow }): ReactElement {
  return (
    <tr data-testid="admin-audit-row">
      <td>{row.createdAt.toISOString()}</td>
      <td>
        {row.actorType}
        {row.actorId ? ` · ${row.actorId.slice(0, 8)}` : ''}
      </td>
      <td data-testid="admin-audit-action">{row.action}</td>
      <td>
        {row.resourceType} · {row.resourceId.slice(0, 8)}
      </td>
      {/*
        Rendered as text by React, which escapes it. Audit metadata carries
        operator-written reasons, so it is the one column on this page an
        outsider can influence.
      */}
      <td>{describe(row.metadata)}</td>
    </tr>
  );
}

function describe(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return '—';
  if (typeof metadata !== 'object') return String(metadata);
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length === 0) return '—';
  return entries
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' · ');
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
