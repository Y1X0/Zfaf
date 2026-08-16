import { beforeEach, describe, expect, it } from 'vitest';

import {
  type AnalyticsBuffer,
  type AnalyticsRepository,
  type Clock,
  type DailySaltStore,
  type InvitationAnalytics,
  type InvitationRepository,
  type PendingAnalyticsEvent,
  type PublicSlugIdentity,
  flushAnalytics,
  recordView,
} from '@zfaf/core';

/**
 * Counting a view, and writing the batch (D8.1–D8.3).
 *
 * The behaviour under test is mostly about **refusing to break the page**. A
 * wedding guest is not our user; every failure mode below has to end with the
 * invitation still rendering and nothing identifying kept.
 */

const NOW = new Date('2026-08-16T12:00:00.000Z');
const clock: Clock = { now: () => NOW };

class FakeSalt implements DailySaltStore {
  calls = 0;
  constructor(private readonly value: string | Error = 'salt-of-the-day') {}
  async currentSalt(): Promise<string> {
    this.calls += 1;
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

class FakeBuffer implements AnalyticsBuffer {
  readonly pushed: PendingAnalyticsEvent[] = [];
  failOnPush: Error | null = null;
  failOnDrain: Error | null = null;

  async push(event: PendingAnalyticsEvent): Promise<void> {
    if (this.failOnPush) throw this.failOnPush;
    this.pushed.push(event);
  }
  async drain(max: number): Promise<readonly PendingAnalyticsEvent[]> {
    if (this.failOnDrain) throw this.failOnDrain;
    return this.pushed.splice(0, max);
  }
  async size(): Promise<number> {
    return this.pushed.length;
  }
}

class FakeAnalyticsRepository implements AnalyticsRepository {
  readonly written: PendingAnalyticsEvent[] = [];
  failNext: Error | null = null;

  async recordBatch(events: readonly PendingAnalyticsEvent[]): Promise<number> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.written.push(...events);
    return events.length;
  }
  async statsFor(): Promise<InvitationAnalytics> {
    return {
      views: 0,
      uniqueVisitors: 0,
      devices: { mobile: 0, tablet: 0, desktop: 0 },
      firstSeenAt: null,
      lastSeenAt: null,
    };
  }
}

/** Only the one method `recordView` reaches for; the rest would be dead weight. */
function invitationsResolving(identity: PublicSlugIdentity | null): InvitationRepository {
  return {
    resolvePublicSlug: async () => identity,
  } as unknown as InvitationRepository;
}

const published: PublicSlugIdentity = {
  invitationId: '2f6c0f6a-1b1a-4e40-9a1e-000000000001',
  status: 'PUBLISHED',
  expiresAt: null,
};

const beacon = { slug: 'ahmad-and-sara', type: 'view' } as const;

describe('recordView', () => {
  let salt: FakeSalt;
  let buffer: FakeBuffer;

  beforeEach(() => {
    salt = new FakeSalt();
    buffer = new FakeBuffer();
  });

  const deps = () => ({
    invitations: invitationsResolving(published),
    salt,
    buffer,
    clock,
  });

  it('buffers a view for a published invitation', async () => {
    const outcome = await recordView(
      { beacon, ip: '86.98.1.1', userAgent: 'Mozilla/5.0 (iPhone) Mobile/15E148' },
      deps(),
    );

    expect(outcome).toEqual({ recorded: true });
    expect(buffer.pushed).toHaveLength(1);
    expect(buffer.pushed[0]?.deviceClass).toBe('mobile');
    expect(buffer.pushed[0]?.invitationId).toBe(published.invitationId);
  });

  it('never puts the address in the buffered event', async () => {
    await recordView({ beacon, ip: '86.98.1.1', userAgent: 'Mozilla/5.0' }, deps());

    const serialised = JSON.stringify(buffer.pushed[0], (_key, value) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('hex') : (value as unknown),
    );
    expect(serialised).not.toContain('86.98');
    expect(serialised).not.toContain('Mozilla');
  });

  it('refuses a malformed beacon', async () => {
    const outcome = await recordView(
      { beacon: { slug: 'x', type: 'maps_click' }, ip: '1.1.1.1', userAgent: null },
      deps(),
    );
    expect(outcome).toEqual({ recorded: false, reason: 'INVALID' });
    expect(buffer.pushed).toHaveLength(0);
  });

  it('refuses an unknown slug', async () => {
    const outcome = await recordView(
      { beacon, ip: '1.1.1.1', userAgent: null },
      {
        ...deps(),
        invitations: invitationsResolving(null),
      },
    );
    expect(outcome).toEqual({ recorded: false, reason: 'UNKNOWN_SLUG' });
  });

  it('does not count a view of a suspended invitation', async () => {
    // Otherwise a scanner replaying the beacon would keep inflating the
    // numbers for a page nobody can actually see.
    const outcome = await recordView(
      { beacon, ip: '1.1.1.1', userAgent: null },
      {
        ...deps(),
        invitations: invitationsResolving({ ...published, status: 'SUSPENDED' }),
      },
    );
    expect(outcome).toEqual({ recorded: false, reason: 'NOT_PUBLIC' });
    expect(buffer.pushed).toHaveLength(0);
  });

  it('does not count a view of a draft or a paused invitation', async () => {
    for (const status of ['DRAFT', 'PAUSED', 'DELETED'] as const) {
      const outcome = await recordView(
        { beacon, ip: '1.1.1.1', userAgent: null },
        {
          ...deps(),
          invitations: invitationsResolving({ ...published, status }),
        },
      );
      expect(outcome).toEqual({ recorded: false, reason: 'NOT_PUBLIC' });
    }
  });

  it('does not count a view after the invitation has expired', async () => {
    const outcome = await recordView(
      { beacon, ip: '1.1.1.1', userAgent: null },
      {
        ...deps(),
        invitations: invitationsResolving({
          ...published,
          expiresAt: new Date(NOW.getTime() - 1),
        }),
      },
    );
    expect(outcome).toEqual({ recorded: false, reason: 'NOT_PUBLIC' });
  });

  it('reports rather than throws when the salt store is unreachable', async () => {
    // Redis being down must degrade to "views not counted", never to a failed
    // request on somebody's wedding invitation.
    const outcome = await recordView(
      { beacon, ip: '1.1.1.1', userAgent: null },
      {
        ...deps(),
        salt: new FakeSalt(new Error('redis down')),
      },
    );
    expect(outcome).toEqual({ recorded: false, reason: 'BUFFER_UNAVAILABLE' });
  });

  it('reports rather than throws when the buffer refuses the write', async () => {
    buffer.failOnPush = new Error('connection reset');
    const outcome = await recordView({ beacon, ip: '1.1.1.1', userAgent: null }, deps());
    expect(outcome).toEqual({ recorded: false, reason: 'BUFFER_UNAVAILABLE' });
  });

  it('gives the same visitor one hash and two visitors two', async () => {
    await recordView({ beacon, ip: '86.98.1.1', userAgent: 'UA' }, deps());
    await recordView({ beacon, ip: '86.98.1.1', userAgent: 'UA' }, deps());
    await recordView({ beacon, ip: '86.98.1.2', userAgent: 'UA' }, deps());

    const [first, second, third] = buffer.pushed;
    expect(first?.visitorHash).toEqual(second?.visitorHash);
    expect(first?.visitorHash).not.toEqual(third?.visitorHash);
  });
});

describe('flushAnalytics', () => {
  function event(index: number): PendingAnalyticsEvent {
    return {
      invitationId: `inv-${index}`,
      type: 'view',
      visitorHash: new Uint8Array(32).fill(index % 255),
      deviceClass: 'mobile',
      occurredAt: NOW,
    };
  }

  it('writes everything waiting and reports the count', async () => {
    const buffer = new FakeBuffer();
    const repository = new FakeAnalyticsRepository();
    for (let index = 0; index < 30; index += 1) await buffer.push(event(index));

    const report = await flushAnalytics({ buffer, repository });

    expect(report.written).toBe(30);
    expect(report.remaining).toBe(0);
    expect(report.failures).toEqual([]);
    expect(repository.written).toHaveLength(30);
  });

  it('does nothing, loudly or otherwise, on an empty buffer', async () => {
    const report = await flushAnalytics({
      buffer: new FakeBuffer(),
      repository: new FakeAnalyticsRepository(),
    });
    expect(report).toMatchObject({ written: 0, batches: 0, remaining: 0, failures: [] });
  });

  it('reports a failed write instead of swallowing it', async () => {
    const buffer = new FakeBuffer();
    const repository = new FakeAnalyticsRepository();
    await buffer.push(event(1));
    repository.failNext = new Error('deadlock detected');

    const report = await flushAnalytics({ buffer, repository });

    // The batch is gone — putting it back would build a poison-pill loop that
    // blocks every good event behind it. Losing it silently is the part that
    // would be unacceptable.
    expect(report.written).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('deadlock detected');
  });

  it('reports a failed drain and stops rather than spinning', async () => {
    const buffer = new FakeBuffer();
    buffer.failOnDrain = new Error('redis down');
    const report = await flushAnalytics({ buffer, repository: new FakeAnalyticsRepository() });

    expect(report.batches).toBe(0);
    expect(report.failures[0]).toContain('redis down');
  });

  it('bounds one run and leaves the rest for the next tick', async () => {
    // 20 batches of 500 is the cap. A backlog must not turn into one enormous
    // transaction that holds a connection for minutes.
    const buffer = new FakeBuffer();
    const repository = new FakeAnalyticsRepository();
    for (let index = 0; index < 10_400; index += 1) await buffer.push(event(index));

    const report = await flushAnalytics({ buffer, repository });

    expect(report.written).toBe(10_000);
    expect(report.batches).toBe(20);
    expect(report.remaining).toBe(400);
  });
});
