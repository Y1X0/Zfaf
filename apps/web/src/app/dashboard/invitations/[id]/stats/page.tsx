import { notFound } from 'next/navigation';

import { invitationStatsPanel } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { requireActor } from '../../../../../server/request-context.js';
import '../../../../dashboard.css';

/**
 * The stats panel (D8.4).
 *
 * A server component with no client island, unlike the replies page. There is
 * nothing to type into and nothing to filter — four numbers and a breakdown —
 * so shipping React to the browser to render them would be paying for
 * interactivity that does not exist.
 *
 * The panel states what the numbers are *not*, on the page rather than in a
 * tooltip. Unique visitors is approximate by construction: the salt rotates
 * every day, so somebody who opens the invitation on Monday and again on
 * Friday counts twice (ADR-0009). A dashboard that presents an approximation
 * as a fact is a dashboard people make decisions on incorrectly.
 */

export const dynamic = 'force-dynamic';

export default async function StatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const session = await requireActor();
  if (!session.authenticated) notFound();

  const { id } = await params;
  const deps = container();
  const result = await invitationStatsPanel(
    { actor: session.actor, invitationId: id },
    { invitations: deps.invitations, analytics: deps.analytics, rsvps: deps.rsvps },
  );

  // 404 for both "not yours" and "does not exist" — the same rule the API
  // follows, so this page cannot become the enumeration oracle the API is not.
  if (!result.ok) notFound();

  const { panel } = result;
  const totalDevices = panel.devices.mobile + panel.devices.tablet + panel.devices.desktop;

  return (
    <main className="zfd" dir="rtl" lang="ar">
      <div className="zfd__bar">
        <h1 className="zfd__title">إحصاءات الدعوة</h1>
        <a className="zfd-btn zfd-btn--quiet" href={`/dashboard/invitations/${id}/rsvps`}>
          الردود
        </a>
      </div>

      <section className="zfd-stats" aria-label="الأرقام">
        <Stat label="المشاهدات" value={panel.views} testId="stat-views" />
        <Stat label="زوار مختلفون" value={panel.uniqueVisitors} testId="stat-unique" />
        <Stat label="الردود" value={panel.rsvp.responses} testId="stat-responses" />
        <Stat label="عدد الحضور" value={panel.rsvp.guests} testId="stat-guests" />
      </section>

      <section aria-label="الأجهزة">
        <h2 className="zfd__title">الأجهزة</h2>
        {totalDevices === 0 ? (
          <p className="zfd-empty" data-testid="devices-empty">
            لا توجد مشاهدات بعد.
          </p>
        ) : (
          <ul className="zfd-list" data-testid="device-breakdown">
            <Device label="جوال" value={panel.devices.mobile} total={totalDevices} kind="mobile" />
            <Device label="لوحي" value={panel.devices.tablet} total={totalDevices} kind="tablet" />
            <Device
              label="حاسوب"
              value={panel.devices.desktop}
              total={totalDevices}
              kind="desktop"
            />
          </ul>
        )}
      </section>

      {/*
        Two honest caveats, on the page. The first is the privacy design
        showing through (ADR-0009); the second is the sixty-second flush
        (D8.3). Both would otherwise be discovered as "the numbers look wrong".
      */}
      <section className="zfd-note" aria-label="ملاحظات">
        <p>
          لا نستخدم أي كوكيز ولا نحفظ عناوين الزوار. «زوار مختلفون» تقدير يومي: من يفتح الدعوة في
          يومين مختلفين يُحتسب مرتين.
        </p>
        <p>قد تتأخر الأرقام حتى دقيقة واحدة.</p>
      </section>
    </main>
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
      <strong className="zfd-stat__value" data-testid={testId}>
        {value}
      </strong>
      <span className="zfd-stat__label">{label}</span>
    </div>
  );
}

function Device({
  label,
  value,
  total,
  kind,
}: {
  label: string;
  value: number;
  total: number;
  kind: string;
}): React.ReactElement {
  const share = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <li className="zfd-row zfd-device" data-testid={`device-${kind}`}>
      <span className="zfd-row__name">{label}</span>
      {/*
        A `meter` rather than a styled rectangle: it carries the value and the
        maximum to a screen reader, which a decorated div does not. The visible
        figure beside it is what a sighted reader uses, so the meter itself is
        hidden from the accessibility tree to avoid announcing both.
      */}
      <meter className="zfd-device__bar" min={0} max={total} value={value} aria-hidden="true" />
      <span className="zfd-row__meta">
        {value} ({share}%)
      </span>
    </li>
  );
}
