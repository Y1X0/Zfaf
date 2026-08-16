import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import {
  type Actor,
  type PendingAnalyticsEvent,
  createSnapshot,
  deviceClassOf,
  flushAnalytics,
  recordView,
  saltDay,
  systemClock,
  tenantScopeFor,
  visitorHash,
} from '@zfaf/core';
import { RedisAnalyticsBuffer, RedisDailySalt, closeRedis, getRedis } from '@zfaf/infra/analytics';

import { PrismaAnalyticsRepository } from '../src/repositories/analytics.repository.js';
import { PrismaInvitationRepository } from '../src/repositories/invitation.repository.js';
import {
  resetDatabase,
  seedInvitation,
  seedTemplate,
  seedUser,
  snapshotFixture,
  testClient,
} from './helpers/database.js';

/**
 * Analytics against real PostgreSQL and real Redis (D8.1–D8.4).
 *
 * The claims under test are privacy claims, and a privacy claim verified
 * against a mock is worth nothing. So these go to the actual database and
 * check the actual table — including one test that reads every column of
 * `analytics_events` and asserts that no address is in any of them, which is
 * the only form of that assertion an auditor should accept.
 */

const REDIS_URL =
  process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

let prisma: PrismaClient;
let analytics: PrismaAnalyticsRepository;
let invitations: PrismaInvitationRepository;
let templateVersionId: string;
let ownerId: string;
let invitationId: string;
let slug: string;
let buffer: RedisAnalyticsBuffer;
let salt: RedisDailySalt;

const redis = () => getRedis(REDIS_URL);

/** A fresh Redis key per test file run, so a stale buffer cannot leak in. */
const BUFFER_KEY = `zfaf:test:analytics:${randomUUID()}`;

beforeAll(async () => {
  prisma = testClient();
  analytics = new PrismaAnalyticsRepository(prisma);
  invitations = new PrismaInvitationRepository(prisma);
  buffer = new RedisAnalyticsBuffer(redis(), BUFFER_KEY);
  salt = new RedisDailySalt(redis());
  await resetDatabase(prisma);
  templateVersionId = await seedTemplate(prisma);
});

afterAll(async () => {
  await redis().del(BUFFER_KEY);
  await closeRedis();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.analyticsEvent.deleteMany({});
  await redis().del(BUFFER_KEY);
  ownerId = await seedUser(prisma);
  invitationId = await seedInvitation(prisma, { ownerId, templateVersionId });
  slug = `slug-${invitationId.slice(0, 8)}`;
  await publish(invitationId, slug);
});

function scopeFor(userId: string) {
  const actor: Actor = {
    kind: 'user',
    userId,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 's',
    memberships: [],
  };
  const scope = tenantScopeFor(actor);
  if (!scope) throw new Error('expected a scope');
  return scope;
}

/**
 * Publishes properly rather than setting the column.
 *
 * A check constraint refuses a PUBLISHED invitation that points at no version
 * (M1), and going through `publish` is what keeps this test honest about the
 * state the code under test will actually meet.
 */
async function publish(id: string, withSlug: string): Promise<void> {
  const snapshot = createSnapshot(snapshotFixture());
  if (!snapshot.ok) throw new Error('fixture snapshot is invalid');
  const outcome = await invitations.publish(
    {
      invitationId: id,
      slug: withSlug,
      snapshot: snapshot.snapshot,
      publishedBy: ownerId,
      expiresAt: null,
      now: new Date(),
    },
    scopeFor(ownerId),
  );
  if (!outcome.ok) throw new Error(`publish failed: ${outcome.error}`);
}

function event(overrides: Partial<PendingAnalyticsEvent> = {}): PendingAnalyticsEvent {
  return {
    invitationId,
    type: 'view',
    visitorHash: new Uint8Array(32).fill(1),
    deviceClass: 'mobile',
    occurredAt: new Date(),
    ...overrides,
  };
}

// ── the privacy claim ───────────────────────────────────────────────────────

describe('what actually reaches the database', () => {
  it('stores no IP address in any column of analytics_events', async () => {
    // Read directly, not through the repository. A repository that filtered an
    // address on the way out would pass a projection-level test and still have
    // written it to disk.
    await analytics.recordBatch([
      event({
        visitorHash: visitorHash({
          salt: 'today',
          ip: '86.98.123.45',
          userAgent: 'Mozilla/5.0 (iPhone) Mobile/15E148',
          invitationId,
        }),
      }),
    ]);

    const rows = await prisma.$queryRaw<readonly Record<string, unknown>[]>`
      SELECT * FROM analytics_events
    `;
    expect(rows).toHaveLength(1);

    // Every value, whatever its type, flattened to text. The `id` column is a
    // bigint and would otherwise abort the serialisation before it reached the
    // columns being checked.
    const dumped = JSON.stringify(rows, (_key, value) => {
      if (Buffer.isBuffer(value)) return value.toString('hex');
      if (typeof value === 'bigint') return value.toString();
      return value as unknown;
    });
    expect(dumped).not.toContain('86.98');
    expect(dumped).not.toContain('123.45');
    // The full User-Agent is a near-unique identifier and is equally absent.
    expect(dumped).not.toContain('Mozilla');
  });

  it('has no column that could hold an address', async () => {
    const columns = await prisma.$queryRaw<readonly { column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'analytics_events'
    `;
    const names = columns.map((column) => column.column_name).sort();

    // The deferred fields are absent from the schema too, not merely unwritten
    // (ADR-0009 amendment): country and referrer_class are Phase 2.
    expect(names).toEqual([
      'device_class',
      'id',
      'invitation_id',
      'occurred_at',
      'type',
      'visitor_hash',
    ]);
    expect(names).not.toContain('ip');
    expect(names).not.toContain('ip_address');
    expect(names).not.toContain('user_agent');
  });

  it('never writes the daily salt to the database', async () => {
    const today = await salt.currentSalt(new Date());
    await analytics.recordBatch([event()]);

    // Every table, not only the analytics one: a salt leaked into `settings`
    // or `audit_logs` would break the same promise.
    const tables = await prisma.$queryRaw<readonly { table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;

    for (const { table_name: table } of tables) {
      const hits = await prisma
        .$queryRawUnsafe<readonly { found: bigint }[]>(
          `SELECT COUNT(*) AS found FROM "${table}" WHERE CAST(to_jsonb(t) AS text) LIKE $1`,
          `%${today}%`,
        )
        .catch(() => [{ found: 0n }]);
      expect(Number(hits[0]?.found ?? 0)).toBe(0);
    }
  });
});

// ── the salt ────────────────────────────────────────────────────────────────

describe('the daily salt', () => {
  it('is the same for every request within a day', async () => {
    const first = await salt.currentSalt(new Date('2026-08-16T01:00:00.000Z'));
    const second = await salt.currentSalt(new Date('2026-08-16T23:00:00.000Z'));
    expect(second).toBe(first);
  });

  it('expires rather than living forever', async () => {
    const now = new Date();
    await salt.currentSalt(now);
    const ttl = await salt.ttlFor(now);
    // A salt without a TTL is a salt that can be recovered later, which is the
    // one thing ADR-0009 says must not be possible.
    expect(ttl).not.toBeNull();
    expect(ttl ?? 0).toBeGreaterThan(0);
    expect(ttl ?? 0).toBeLessThanOrEqual(26 * 60 * 60);
  });

  it('gives a different salt on a different day', async () => {
    const monday = await salt.currentSalt(new Date('2026-08-16T12:00:00.000Z'));
    const tuesday = await salt.currentSalt(new Date('2026-08-17T12:00:00.000Z'));
    expect(tuesday).not.toBe(monday);

    // …and therefore the same visitor hashes differently across two days.
    const visitor = { ip: '86.98.1.1', userAgent: 'UA', invitationId };
    expect(visitorHash({ ...visitor, salt: monday })).not.toEqual(
      visitorHash({ ...visitor, salt: tuesday }),
    );

    await redis().del(`zfaf:analytics:salt:${saltDay(new Date('2026-08-16T12:00:00.000Z'))}`);
    await redis().del(`zfaf:analytics:salt:${saltDay(new Date('2026-08-17T12:00:00.000Z'))}`);
  });
});

// ── the buffer and the flush ────────────────────────────────────────────────

describe('the buffer and the flush', () => {
  it('carries a view from the beacon through Redis into the table', async () => {
    const outcome = await recordView(
      {
        beacon: { slug, type: 'view' },
        ip: '86.98.1.1',
        userAgent: 'Mozilla/5.0 (iPhone) Mobile/15E148',
      },
      { invitations, salt, buffer, clock: systemClock },
    );
    expect(outcome).toEqual({ recorded: true });

    // Nothing in the database yet: that is the point of the buffer.
    expect(await prisma.analyticsEvent.count()).toBe(0);
    expect(await buffer.size()).toBe(1);

    const report = await flushAnalytics({ buffer, repository: analytics });
    expect(report.written).toBe(1);

    const stored = await prisma.analyticsEvent.findFirstOrThrow();
    expect(stored.invitationId).toBe(invitationId);
    expect(stored.deviceClass).toBe('mobile');
    expect(stored.type).toBe('view');
  });

  it('drains in one batch rather than one statement per view', async () => {
    for (let index = 0; index < 250; index += 1) {
      await buffer.push(event({ visitorHash: new Uint8Array(32).fill(index % 255) }));
    }

    const report = await flushAnalytics({ buffer, repository: analytics });

    expect(report.written).toBe(250);
    expect(report.batches).toBe(1);
    expect(await prisma.analyticsEvent.count()).toBe(250);
    expect(await buffer.size()).toBe(0);
  });

  it('does not hand the same view to the database twice', async () => {
    // `RPOP key n` is atomic, so two flushers racing cannot both take an entry.
    for (let index = 0; index < 100; index += 1) await buffer.push(event());

    const [a, b] = await Promise.all([
      flushAnalytics({ buffer, repository: analytics }),
      flushAnalytics({ buffer, repository: analytics }),
    ]);

    expect(a.written + b.written).toBe(100);
    expect(await prisma.analyticsEvent.count()).toBe(100);
  });

  it('drops views for an invitation that vanished, and keeps the rest', async () => {
    const doomed = await seedInvitation(prisma, { ownerId, templateVersionId });
    await analytics.recordBatch([event()]);
    await prisma.invitation.delete({ where: { id: doomed } });

    const written = await analytics.recordBatch([
      event(),
      event({ invitationId: doomed }),
      event(),
    ]);

    // Two of three, rather than a foreign-key error costing the whole batch.
    expect(written).toBe(2);
    expect(await prisma.analyticsEvent.count()).toBe(3);
  });
});

// ── the numbers the couple sees ─────────────────────────────────────────────

describe('statsFor', () => {
  it('counts views, distinct visitors and each device class', async () => {
    const visitorA = new Uint8Array(32).fill(1);
    const visitorB = new Uint8Array(32).fill(2);

    await analytics.recordBatch([
      event({ visitorHash: visitorA, deviceClass: 'mobile' }),
      // The same person opening it again: two views, one visitor.
      event({ visitorHash: visitorA, deviceClass: 'mobile' }),
      event({ visitorHash: visitorB, deviceClass: 'desktop' }),
    ]);

    const stats = await analytics.statsFor(invitationId);

    expect(stats.views).toBe(3);
    expect(stats.uniqueVisitors).toBe(2);
    expect(stats.devices).toEqual({ mobile: 2, tablet: 0, desktop: 1 });
    expect(stats.firstSeenAt).not.toBeNull();
    expect(stats.lastSeenAt).not.toBeNull();
  });

  it('returns zeroes for an invitation nobody has opened', async () => {
    const stats = await analytics.statsFor(invitationId);
    expect(stats).toMatchObject({
      views: 0,
      uniqueVisitors: 0,
      devices: { mobile: 0, tablet: 0, desktop: 0 },
      firstSeenAt: null,
      lastSeenAt: null,
    });
  });

  it('counts only this invitation', async () => {
    const other = await seedInvitation(prisma, { ownerId, templateVersionId });
    await analytics.recordBatch([event(), event({ invitationId: other })]);

    expect((await analytics.statsFor(invitationId)).views).toBe(1);
    expect((await analytics.statsFor(other)).views).toBe(1);
  });

  it('classifies a real phone as mobile end to end', async () => {
    const userAgent =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    await analytics.recordBatch([event({ deviceClass: deviceClassOf(userAgent) })]);
    expect((await analytics.statsFor(invitationId)).devices.mobile).toBe(1);
  });
});
