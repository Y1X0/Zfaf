import { describe, expect, it } from 'vitest';

import {
  EventDateTime,
  clockSkew,
  correctedNow,
  countdownParts,
  wallClockToInstant,
} from './event-date-time.js';

/**
 * Time is the area where this product is most likely to be quietly wrong: a
 * countdown that is an hour off destroys trust immediately, and the bug only
 * appears for users in another zone or after a DST change. These tests exercise
 * exactly those cases.
 */

describe('wallClockToInstant', () => {
  it('resolves a wall-clock time in a fixed-offset zone', () => {
    // Riyadh is UTC+3 year-round: 20:00 local is 17:00Z.
    const instant = wallClockToInstant(2026, 9, 20, 20, 0, 'Asia/Riyadh');
    expect(instant.toISOString()).toBe('2026-09-20T17:00:00.000Z');
  });

  it('resolves a wall-clock time in UTC', () => {
    expect(wallClockToInstant(2026, 1, 1, 0, 0, 'UTC').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('applies the offset in force on the day, not a fixed one', () => {
    // London: GMT in January, BST in July. Same wall time, different instants.
    const winter = wallClockToInstant(2026, 1, 15, 12, 0, 'Europe/London');
    const summer = wallClockToInstant(2026, 7, 15, 12, 0, 'Europe/London');
    expect(winter.toISOString()).toBe('2026-01-15T12:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-15T11:00:00.000Z');
  });

  it('handles a southern-hemisphere zone, where DST runs the other way', () => {
    // Auckland: NZDT (+13) in January, NZST (+12) in July.
    const january = wallClockToInstant(2026, 1, 15, 12, 0, 'Pacific/Auckland');
    const july = wallClockToInstant(2026, 7, 15, 12, 0, 'Pacific/Auckland');
    expect(january.toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(july.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('resolves times on either side of a DST transition', () => {
    // Europe/Berlin springs forward on 2026-03-29 at 02:00 local.
    const before = wallClockToInstant(2026, 3, 28, 20, 0, 'Europe/Berlin');
    const after = wallClockToInstant(2026, 3, 30, 20, 0, 'Europe/Berlin');
    expect(before.toISOString()).toBe('2026-03-28T19:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-30T18:00:00.000Z');
  });
});

describe('EventDateTime.create', () => {
  it('accepts a complete event', () => {
    const result = EventDateTime.create({
      date: '2026-09-20',
      startTime: '20:00',
      endTime: '23:30',
      timezone: 'Asia/Riyadh',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a date without a time', () => {
    const result = EventDateTime.create({ date: '2026-09-20', timezone: 'Asia/Riyadh' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.startTime).toBeNull();
  });

  it.each(['20-09-2026', '2026/09/20', '2026-9-20', 'tomorrow', ''])(
    'rejects the malformed date "%s"',
    (date) => {
      const result = EventDateTime.create({ date, timezone: 'UTC' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INVALID_DATE');
    },
  );

  it('rejects a date that matches the pattern but does not exist', () => {
    // 2026 is not a leap year, and February never has 30 days.
    for (const date of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-04-31']) {
      const result = EventDateTime.create({ date, timezone: 'UTC' });
      expect(result.ok, date).toBe(false);
    }
  });

  it.each(['25:00', '20:60', '8:00', '20:00:00'])(
    'rejects the malformed time "%s"',
    (startTime) => {
      const result = EventDateTime.create({ date: '2026-09-20', startTime, timezone: 'UTC' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('INVALID_TIME');
    },
  );

  it('rejects an unknown time zone rather than silently using UTC', () => {
    const result = EventDateTime.create({ date: '2026-09-20', timezone: 'Mars/Olympus' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('UNKNOWN_TIMEZONE');
  });

  it('rejects an end time before the start on the same date', () => {
    const result = EventDateTime.create({
      date: '2026-09-20',
      startTime: '22:00',
      endTime: '20:00',
      timezone: 'UTC',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('END_BEFORE_START');
  });

  it('rejects an end time with no start time', () => {
    const result = EventDateTime.create({ date: '2026-09-20', endTime: '23:00', timezone: 'UTC' });
    expect(result.ok).toBe(false);
  });
});

describe('countdown correctness across zones', () => {
  it('is identical for guests anywhere in the world', () => {
    // The scenario from docs/00 §6.4: an organiser in Cairo, a wedding in
    // Riyadh, a guest in London. The remaining time is a property of the
    // instant, so all three must see the same number.
    const event = EventDateTime.create({
      date: '2026-09-20',
      startTime: '20:00',
      timezone: 'Asia/Riyadh',
    });
    expect(event.ok).toBe(true);
    if (!event.ok) return;

    const now = new Date('2026-09-19T17:00:00.000Z');
    const remaining = event.value.millisecondsUntil(now);

    expect(remaining).toBe(24 * 3600 * 1000);
    expect(countdownParts(event.value.toInstant(), now)).toEqual({
      days: 1,
      hours: 0,
      minutes: 0,
      seconds: 0,
      totalMilliseconds: 86_400_000,
    });
  });

  it("stays correct when the event spans a DST change in the guest's zone", () => {
    // The guest's own zone is irrelevant — only the event's zone matters.
    const event = EventDateTime.create({
      date: '2026-04-10',
      startTime: '19:00',
      timezone: 'Africa/Cairo',
    });
    expect(event.ok).toBe(true);
    if (!event.ok) return;

    const instant = event.value.toInstant();
    // Whatever Cairo's offset is that day, formatting the instant back into
    // Cairo must return the wall-clock time the organiser typed.
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(instant);
    expect(formatted).toBe('19:00');
  });

  it('counts to midnight local time when only a date is given', () => {
    const event = EventDateTime.create({ date: '2026-09-20', timezone: 'Asia/Riyadh' });
    expect(event.ok).toBe(true);
    if (!event.ok) return;
    expect(event.value.toInstant().toISOString()).toBe('2026-09-19T21:00:00.000Z');
  });

  it('never reports negative time once the event has passed', () => {
    const event = EventDateTime.create({
      date: '2020-01-01',
      startTime: '12:00',
      timezone: 'UTC',
    });
    expect(event.ok).toBe(true);
    if (!event.ok) return;

    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(event.value.millisecondsUntil(now)).toBe(0);
    expect(event.value.hasPassed(now)).toBe(true);
  });
});

describe('countdownParts', () => {
  it('decomposes a duration into display units', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const target = new Date('2026-01-03T04:05:06.000Z');
    expect(countdownParts(target, now)).toEqual({
      days: 2,
      hours: 4,
      minutes: 5,
      seconds: 6,
      totalMilliseconds: 187_506_000,
    });
  });

  it('clamps to zero rather than counting upward', () => {
    const now = new Date('2026-01-05T00:00:00.000Z');
    const target = new Date('2026-01-01T00:00:00.000Z');
    expect(countdownParts(target, now)).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      totalMilliseconds: 0,
    });
  });
});

describe('clock correction (D6.9)', () => {
  const serverNow = new Date('2026-08-16T10:00:00.000Z');

  it('ignores a difference small enough to be network latency', () => {
    // Chasing the round trip would make the countdown twitch by a second for
    // no reason a guest could perceive.
    expect(clockSkew(serverNow, new Date(serverNow.getTime() - 900))).toBe(0);
    expect(clockSkew(serverNow, new Date(serverNow.getTime() + 900))).toBe(0);
  });

  it('measures a device clock that is genuinely wrong', () => {
    const anHourBehind = new Date(serverNow.getTime() - 3_600_000);
    expect(clockSkew(serverNow, anHourBehind)).toBe(3_600_000);

    const aDayAhead = new Date(serverNow.getTime() + 86_400_000);
    expect(clockSkew(serverNow, aDayAhead)).toBe(-86_400_000);
  });

  it('corrects the offset while trusting the device to keep ticking', () => {
    const deviceAtLoad = new Date(serverNow.getTime() - 3_600_000);
    const skew = clockSkew(serverNow, deviceAtLoad);

    // Ten seconds later by the device's own reckoning.
    const deviceLater = new Date(deviceAtLoad.getTime() + 10_000);
    expect(correctedNow(deviceLater, skew).toISOString()).toBe('2026-08-16T10:00:10.000Z');
  });

  it('keeps a badly-set phone from showing the wrong countdown', () => {
    // The most visible possible bug: an invitation telling a guest the wedding
    // was yesterday because their phone's date is wrong.
    const event = EventDateTime.create({
      date: '2026-09-20',
      startTime: '20:00',
      timezone: 'Asia/Riyadh',
    });
    expect(event.ok).toBe(true);
    if (!event.ok) return;

    // A phone set two months fast would put the wedding in the past.
    const phone = new Date('2026-10-16T10:00:00.000Z');
    expect(event.value.hasPassed(phone)).toBe(true);

    const skew = clockSkew(serverNow, phone);
    expect(event.value.hasPassed(correctedNow(phone, skew))).toBe(false);
    expect(countdownParts(event.value.toInstant(), correctedNow(phone, skew)).days).toBe(35);
  });

  it('survives the event’s own time zone changing its offset before the date', () => {
    // A DST transition between now and the wedding must not move the wedding:
    // the instant is derived from the wall-clock time and the tz database, not
    // from a stored offset.
    const event = EventDateTime.create({
      date: '2026-08-01',
      startTime: '20:00',
      timezone: 'Europe/London',
    });
    expect(event.ok).toBe(true);
    if (!event.ok) return;
    // 20:00 BST is 19:00 UTC — an implementation that ignored DST would say 20:00Z.
    expect(event.value.toInstant().toISOString()).toBe('2026-08-01T19:00:00.000Z');

    const winter = EventDateTime.create({
      date: '2026-12-01',
      startTime: '20:00',
      timezone: 'Europe/London',
    });
    expect(winter.ok).toBe(true);
    if (!winter.ok) return;
    expect(winter.value.toInstant().toISOString()).toBe('2026-12-01T20:00:00.000Z');
  });

  it('counts down to the same instant for guests in different time zones', () => {
    // A guest in London and a guest in Riyadh must see the same number: the
    // countdown is to an instant, and only its presentation is local.
    const event = EventDateTime.create({
      date: '2026-09-20',
      startTime: '20:00',
      timezone: 'Asia/Riyadh',
    });
    expect(event.ok).toBe(true);
    if (!event.ok) return;

    const instant = new Date('2026-09-19T20:00:00.000Z');
    expect(countdownParts(event.value.toInstant(), instant).totalMilliseconds).toBe(
      86_400_000 - 3 * 3_600_000,
    );
  });
});
