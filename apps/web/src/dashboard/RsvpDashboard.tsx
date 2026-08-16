'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The couple's list of replies (D7.5).
 *
 * A client island rather than a server page, and the reason is the interaction
 * rather than convenience: searching and filtering a guest list means typing,
 * and a round trip per keystroke on a phone is the difference between a tool
 * and a form. The public invitation is the surface with a hard budget
 * (ADR-0020); this page is behind a session, opened by two people, and the
 * trade runs the other way.
 *
 * Nothing here decides anything. Every filter is re-applied server-side, the
 * rows arrive already scoped, and the export is a link to an endpoint that
 * checks `rsvp:export` on its own.
 */

export interface RsvpRow {
  readonly id: string;
  readonly name: string;
  readonly attending: boolean;
  readonly partySize: number;
  readonly phone: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly submittedAt: string;
}

export interface RsvpStats {
  readonly responses: number;
  readonly attending: number;
  readonly declined: number;
  readonly guests: number;
}

type Filter = 'all' | 'attending' | 'declined';

export function RsvpDashboard({
  invitationId,
  title,
}: {
  invitationId: string;
  title: string;
}): React.ReactElement {
  const [rows, setRows] = useState<readonly RsvpRow[]>([]);
  const [stats, setStats] = useState<RsvpStats | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const listUrl = useMemo(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (filter === 'attending') params.set('attending', 'true');
    if (filter === 'declined') params.set('attending', 'false');
    if (query.trim()) params.set('q', query.trim());
    return `/api/v1/invitations/${invitationId}/rsvps?${params.toString()}`;
  }, [filter, invitationId, query]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [listResponse, statsResponse] = await Promise.all([
          fetch(listUrl, { signal }),
          fetch(`/api/v1/invitations/${invitationId}/rsvps/stats`, { signal }),
        ]);

        if (!listResponse.ok) {
          setError('تعذّر تحميل الردود.');
          return;
        }

        const list = (await listResponse.json()) as { data?: { rsvps: RsvpRow[] } };
        setRows(list.data?.rsvps ?? []);

        if (statsResponse.ok) {
          const body = (await statsResponse.json()) as { data?: RsvpStats };
          setStats(body.data ?? null);
        }
      } catch (cause) {
        // An aborted request is this component doing its job, not a failure.
        if (!signal.aborted) setError('تعذّر الاتصال. أعد المحاولة.');
        void cause;
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [invitationId, listUrl],
  );

  useEffect(() => {
    const controller = new AbortController();
    // Debounced, so typing a name is one request rather than one per letter.
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load]);

  const remove = async (rsvpId: string) => {
    const response = await fetch(`/api/v1/invitations/${invitationId}/rsvps/${rsvpId}`, {
      method: 'DELETE',
    });
    if (response.ok) {
      setRows((current) => current.filter((row) => row.id !== rsvpId));
      const controller = new AbortController();
      // Reloaded rather than adjusted locally: the counters are the couple's
      // catering numbers, and a client-side guess at them would be a number
      // that looks authoritative and is not.
      void load(controller.signal);
    }
  };

  return (
    <div className="zfd">
      <header className="zfd__bar">
        <h1 className="zfd__title">{title}</h1>
        <a
          className="zfd-btn"
          data-testid="rsvp-export"
          href={`/api/v1/invitations/${invitationId}/rsvps/export`}
        >
          تصدير CSV
        </a>
      </header>

      <section className="zfd-stats" aria-label="ملخص الردود" data-testid="rsvp-stats">
        <Stat label="الردود" value={stats?.responses ?? 0} testId="stat-responses" />
        <Stat label="سيحضرون" value={stats?.attending ?? 0} testId="stat-attending" />
        <Stat label="اعتذروا" value={stats?.declined ?? 0} testId="stat-declined" />
        <Stat label="إجمالي الأشخاص" value={stats?.guests ?? 0} testId="stat-guests" />
      </section>

      <div className="zfd-controls">
        <label className="zfd-field">
          <span className="zfd-field__label">بحث</span>
          <input
            className="zfd-field__input"
            type="search"
            data-testid="rsvp-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="اسم أو رقم"
          />
        </label>

        <div className="zfd-filters" role="group" aria-label="تصفية">
          {(
            [
              ['all', 'الكل'],
              ['attending', 'سيحضرون'],
              ['declined', 'اعتذروا'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="zfd-chip"
              data-testid={`rsvp-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="zfd-empty" role="alert" data-testid="rsvp-error">
          {error}
        </p>
      ) : null}

      {!error && !loading && rows.length === 0 ? (
        <p className="zfd-empty" data-testid="rsvp-empty">
          لا توجد ردود بعد.
        </p>
      ) : null}

      <ul className="zfd-list" data-testid="rsvp-list">
        {rows.map((row) => (
          <li className="zfd-row" key={row.id} data-testid="rsvp-row">
            <div className="zfd-row__main">
              {/* React escapes this. A guest chooses their own name, and it is
                  the one value on this page that an outsider controls. */}
              <span className="zfd-row__name">{row.name}</span>
              <span className="zfd-row__meta">
                {row.attending ? `سيحضر · ${row.partySize}` : 'اعتذر'}
              </span>
            </div>
            {row.phone ? (
              <a className="zfd-row__phone" href={`tel:${row.phone}`} dir="ltr">
                {row.phone}
              </a>
            ) : null}
            {row.note ? <p className="zfd-row__note">{row.note}</p> : null}
            <button
              type="button"
              className="zfd-btn zfd-btn--quiet"
              data-testid="rsvp-delete"
              onClick={() => void remove(row.id)}
              aria-label={`حذف رد ${row.name}`}
            >
              حذف
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}): React.ReactElement {
  return (
    <div className="zfd-stat">
      <span className="zfd-stat__value" data-testid={testId}>
        {value}
      </span>
      <span className="zfd-stat__label">{label}</span>
    </div>
  );
}
