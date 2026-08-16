import type { PrismaClient } from '@prisma/client';
import {
  type AnalyticsRepository,
  DEVICE_CLASSES,
  type DeviceClass,
  type InvitationAnalytics,
  type PendingAnalyticsEvent,
  isDeviceClass,
} from '@zfaf/core';

/**
 * Prisma implementation of the analytics repository (D8.3, D8.4).
 *
 * Two operations with opposite shapes. The write is a bulk insert of whatever
 * the flush drained — one statement, because the point of buffering was to
 * stop paying a round trip per view. The read is four aggregates computed in
 * SQL, because "unique visitors" is `COUNT(DISTINCT visitor_hash)` and doing
 * that in JavaScript would mean loading every event ever recorded to answer a
 * four-number question.
 *
 * What is *not* here is as deliberate as what is. There is no method that
 * returns raw events, no method that takes an IP address, and no column in the
 * table to hold one. The privacy property from ADR-0009 is enforced by the
 * schema — a caller cannot store an address here even by mistake, because
 * there is nowhere to put it.
 */
export class PrismaAnalyticsRepository implements AnalyticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async recordBatch(events: readonly PendingAnalyticsEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    try {
      const result = await this.prisma.analyticsEvent.createMany({ data: events.map(toRow) });
      return result.count;
    } catch (error) {
      /**
       * One dead invitation must not cost the batch.
       *
       * An invitation can be hard-deleted in the minute between a view and the
       * flush, and the foreign key then rejects the **whole** `createMany` —
       * losing several hundred perfectly good views because of one. So the
       * happy path stays a single statement, and only a foreign-key failure
       * pays for a second query that finds which invitations still exist.
       *
       * Narrow on purpose: any other error is rethrown, because a flush that
       * quietly swallowed a connection failure would report "written: 0" and
       * look like an idle system.
       */
      if (!isForeignKeyViolation(error)) throw error;

      const ids = [...new Set(events.map((event) => event.invitationId))];
      const alive = new Set(
        (
          await this.prisma.invitation.findMany({
            where: { id: { in: ids } },
            select: { id: true },
          })
        ).map((row) => row.id),
      );

      const survivors = events.filter((event) => alive.has(event.invitationId));
      const dropped = events.length - survivors.length;
      if (dropped > 0) {
        console.warn(`[analytics] dropped ${dropped} view(s) for invitations that no longer exist`);
      }
      if (survivors.length === 0) return 0;

      const result = await this.prisma.analyticsEvent.createMany({ data: survivors.map(toRow) });
      return result.count;
    }
  }

  async statsFor(invitationId: string): Promise<InvitationAnalytics> {
    /**
     * One query, computed by PostgreSQL.
     *
     * `COUNT(DISTINCT visitor_hash)` is the unique-visitor figure, and it is
     * distinct *within a day* by construction: the salt rotates every 24 hours
     * (ADR-0009), so the same person on two days produces two different
     * hashes and counts twice. That is the price of not tracking anybody, and
     * the dashboard says so rather than implying a precision it does not have.
     */
    const rows = await this.prisma.$queryRaw<
      readonly {
        views: bigint;
        uniques: bigint;
        device_class: string | null;
        first_seen: Date | null;
        last_seen: Date | null;
      }[]
    >`
      SELECT
        COUNT(*)                          AS views,
        COUNT(DISTINCT visitor_hash)      AS uniques,
        device_class,
        MIN(occurred_at)                  AS first_seen,
        MAX(occurred_at)                  AS last_seen
      FROM analytics_events
      WHERE invitation_id = ${invitationId}::uuid
      GROUP BY ROLLUP (device_class)
    `;

    const devices: Record<DeviceClass, number> = { mobile: 0, tablet: 0, desktop: 0 };
    let views = 0;
    let uniqueVisitors = 0;
    let firstSeenAt: Date | null = null;
    let lastSeenAt: Date | null = null;

    for (const row of rows) {
      if (row.device_class === null) {
        // The `ROLLUP` total row: the only one whose DISTINCT count spans every
        // device, which is why uniques cannot be summed from the groups.
        views = Number(row.views);
        uniqueVisitors = Number(row.uniques);
        firstSeenAt = row.first_seen;
        lastSeenAt = row.last_seen;
        continue;
      }

      // A device class the table does not recognise is counted in the total but
      // not attributed — dropping it silently would make the breakdown
      // disagree with the headline figure for no visible reason.
      if (isDeviceClass(row.device_class)) {
        devices[row.device_class] = Number(row.views);
      }
    }

    return { views, uniqueVisitors, devices: { ...devices }, firstSeenAt, lastSeenAt };
  }

  /** Exposed for the retention job and for tests; never for a user-facing read. */
  async countFor(invitationId: string): Promise<number> {
    return await this.prisma.analyticsEvent.count({ where: { invitationId } });
  }
}

function toRow(event: PendingAnalyticsEvent) {
  return {
    invitationId: event.invitationId,
    type: event.type,
    visitorHash: Buffer.from(event.visitorHash),
    deviceClass: event.deviceClass,
    occurredAt: event.occurredAt,
  };
}

/** PostgreSQL 23503, which Prisma surfaces as P2003. */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2003'
  );
}

/** Re-exported so a caller can iterate the buckets without importing core twice. */
export { DEVICE_CLASSES };
