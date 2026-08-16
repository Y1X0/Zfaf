import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_EVENT_TYPES,
  AnalyticsBeaconSchema,
  DEVICE_CLASSES,
  type PendingAnalyticsEvent,
  decodeBufferedEvent,
  deviceClassOf,
  encodeBufferedEvent,
  isDeviceClass,
  saltDay,
  visitorHash,
} from '@zfaf/core';

/**
 * The privacy mechanism itself (D8.1, ADR-0009).
 *
 * These are the tests that hold the platform's central privacy claim up. The
 * claim is not "we handle data carefully" — it is the specific, checkable
 * statement that *after a day has passed, nobody including us can link a
 * visitor across two days or reverse a hash to an address*. Everything below
 * checks one half of that.
 */

const salt = 'salt-of-the-day';

describe('visitorHash', () => {
  it('produces the same hash for the same visitor within a day', () => {
    const input = { salt, ip: '86.98.1.1', userAgent: 'Mozilla/5.0', invitationId: 'inv-1' };
    expect(visitorHash(input)).toEqual(visitorHash(input));
  });

  it('produces a different hash for the same visitor on a different day', () => {
    // The whole of the ADR's promise: the salt rotates, so yesterday's hash
    // and today's are unrelated and cannot be joined.
    const monday = visitorHash({
      salt: 'monday-salt',
      ip: '86.98.1.1',
      userAgent: 'UA',
      invitationId: 'inv-1',
    });
    const tuesday = visitorHash({
      salt: 'tuesday-salt',
      ip: '86.98.1.1',
      userAgent: 'UA',
      invitationId: 'inv-1',
    });
    expect(monday).not.toEqual(tuesday);
  });

  it('produces a different hash for the same visitor on a different invitation', () => {
    // One couple's analytics must never be joinable against another's.
    const first = visitorHash({ salt, ip: '86.98.1.1', userAgent: 'UA', invitationId: 'inv-1' });
    const second = visitorHash({ salt, ip: '86.98.1.1', userAgent: 'UA', invitationId: 'inv-2' });
    expect(first).not.toEqual(second);
  });

  it('separates two visitors behind different addresses', () => {
    const a = visitorHash({ salt, ip: '86.98.1.1', userAgent: 'UA', invitationId: 'inv-1' });
    const b = visitorHash({ salt, ip: '86.98.1.2', userAgent: 'UA', invitationId: 'inv-1' });
    expect(a).not.toEqual(b);
  });

  it('is 32 bytes and contains nothing recoverable', () => {
    const hash = visitorHash({
      salt,
      ip: '86.98.1.1',
      userAgent: 'UA',
      invitationId: 'inv-1',
    });
    expect(hash).toHaveLength(32);

    // The address must not survive in any recognisable form. A weak
    // implementation that concatenated instead of hashing would pass every
    // test above and fail this one.
    const asText = Buffer.from(hash).toString('latin1');
    expect(asText).not.toContain('86.98');
    expect(Buffer.from(hash).toString('hex')).not.toContain('inv-1');
  });

  it('tolerates a missing user agent', () => {
    expect(() =>
      visitorHash({ salt, ip: '1.1.1.1', userAgent: null, invitationId: 'inv-1' }),
    ).not.toThrow();
  });
});

describe('saltDay', () => {
  it('is the UTC calendar day', () => {
    expect(saltDay(new Date('2026-08-16T23:59:59.999Z'))).toBe('2026-08-16');
    expect(saltDay(new Date('2026-08-17T00:00:00.000Z'))).toBe('2026-08-17');
  });
});

describe('deviceClassOf', () => {
  const cases: readonly [string, string][] = [
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'mobile',
    ],
    ['Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 Mobile Safari/537.36', 'mobile'],
    // An Android tablet says "Android" without "Mobile" — the one rule that
    // makes the tablet bucket mean anything at all.
    ['Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Safari/537.36', 'tablet'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'tablet'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1',
      'desktop',
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', 'desktop'],
  ];

  for (const [userAgent, expected] of cases) {
    it(`classifies "${userAgent.slice(0, 40)}…" as ${expected}`, () => {
      expect(deviceClassOf(userAgent)).toBe(expected);
    });
  }

  it('treats an absent or unrecognised agent as desktop', () => {
    // "Desktop" is the honest default: a bot or a curl is certainly not a phone.
    expect(deviceClassOf(null)).toBe('desktop');
    expect(deviceClassOf('curl/8.4.0')).toBe('desktop');
    expect(deviceClassOf('')).toBe('desktop');
  });

  it('only ever returns one of the three published buckets', () => {
    const agents = ['iPhone', 'iPad', 'Kindle', 'PlayBook', 'Windows Phone', 'unknown', ''];
    for (const agent of agents) {
      expect(DEVICE_CLASSES).toContain(deviceClassOf(agent));
    }
  });

  it('recognises the bucket names and refuses anything else', () => {
    expect(isDeviceClass('mobile')).toBe(true);
    expect(isDeviceClass('watch')).toBe(false);
  });
});

describe('AnalyticsBeaconSchema', () => {
  it('accepts a slug and the one permitted type', () => {
    const parsed = AnalyticsBeaconSchema.safeParse({ slug: 'ahmad-and-sara', type: 'view' });
    expect(parsed.success).toBe(true);
  });

  it('permits exactly one event type', () => {
    // The MVP was cut to views, uniques, replies and device class. Accepting
    // `maps_click` "for later" would mean collecting what we decided not to.
    expect(ANALYTICS_EVENT_TYPES).toEqual(['view']);
    expect(AnalyticsBeaconSchema.safeParse({ slug: 'x', type: 'maps_click' }).success).toBe(false);
  });

  it('refuses an unexpected field rather than ignoring it', () => {
    const parsed = AnalyticsBeaconSchema.safeParse({
      slug: 'ahmad-and-sara',
      type: 'view',
      // A client trying to tell us who it is. `.strict()` is what makes this a
      // refusal rather than a silently dropped value.
      visitorId: 'tracking-me',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an empty or oversized slug', () => {
    expect(AnalyticsBeaconSchema.safeParse({ slug: '', type: 'view' }).success).toBe(false);
    expect(AnalyticsBeaconSchema.safeParse({ slug: 'a'.repeat(200), type: 'view' }).success).toBe(
      false,
    );
  });
});

describe('the buffer encoding', () => {
  const event: PendingAnalyticsEvent = {
    invitationId: '2f6c0f6a-1b1a-4e40-9a1e-000000000001',
    type: 'view',
    visitorHash: new Uint8Array(32).fill(7),
    deviceClass: 'mobile',
    occurredAt: new Date('2026-08-16T12:00:00.000Z'),
  };

  it('round-trips an event', () => {
    const decoded = decodeBufferedEvent(encodeBufferedEvent(event));
    expect(decoded).toEqual(event);
  });

  it('returns null rather than throwing on anything malformed', () => {
    // One corrupt entry must not abort a flush carrying hundreds of good ones.
    for (const bad of [
      'not json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ i: '', t: 'view', v: '00'.repeat(32), d: 'mobile', o: 1 }),
      JSON.stringify({ i: 'x', t: 'share', v: '00'.repeat(32), d: 'mobile', o: 1 }),
      JSON.stringify({ i: 'x', t: 'view', v: 'not-hex', d: 'mobile', o: 1 }),
      JSON.stringify({ i: 'x', t: 'view', v: '00'.repeat(32), d: 'watch', o: 1 }),
      JSON.stringify({ i: 'x', t: 'view', v: '00'.repeat(32), d: 'mobile', o: 'soon' }),
    ]) {
      expect(decodeBufferedEvent(bad)).toBeNull();
    }
  });

  it('carries no address, no user agent and no cookie', () => {
    // The encoded form is what sits in Redis, so this is a direct check that
    // nothing identifying is at rest there either.
    const encoded = encodeBufferedEvent(event);
    expect(encoded).not.toContain('Mozilla');
    expect(encoded).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(Object.keys(JSON.parse(encoded) as object).sort()).toEqual(['d', 'i', 'o', 't', 'v']);
  });
});
