import { type Result, err, ok } from '@zfaf/shared';

/**
 * Wedding date and time (docs/03-database-erd.md §4.3).
 *
 * Stored as local wall-clock plus an IANA time zone, never as a bare UTC
 * instant. Countries in this region have changed their DST rules more than once
 * in recent years; storing the instant would silently move a wedding when the
 * tz database is updated, while storing "8pm in Riyadh" stays correct by
 * construction.
 *
 * The UTC instant is derived at display time from the current tz database.
 */

export type EventDateTimeIssue =
  'INVALID_DATE' | 'INVALID_TIME' | 'UNKNOWN_TIMEZONE' | 'END_BEFORE_START';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset (in ms) that `timezone` was at the given instant.
 *
 * Derived from the runtime's tz database via `Intl`, so DST and historical rule
 * changes are handled by the platform rather than by us.
 */
function timezoneOffsetAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };

  const asIfUtc = Date.UTC(
    lookup('year'),
    lookup('month') - 1,
    lookup('day'),
    lookup('hour'),
    lookup('minute'),
    lookup('second'),
  );

  return asIfUtc - instant.getTime();
}

/**
 * Converts a local wall-clock time in `timezone` to a UTC instant.
 *
 * Uses guess-then-correct: the offset itself depends on the instant, so an
 * initial guess is refined once. Two passes are sufficient for every real tz
 * rule, including DST boundaries.
 */
export function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = timezoneOffsetAt(new Date(guess), timezone);
  const firstPass = guess - firstOffset;
  const secondOffset = timezoneOffsetAt(new Date(firstPass), timezone);
  return secondOffset === firstOffset ? new Date(firstPass) : new Date(guess - secondOffset);
}

export class EventDateTime {
  private constructor(
    /** `YYYY-MM-DD` in the event's own time zone. */
    readonly date: string,
    /** `HH:mm` in the event's own time zone, or null when only a date is known. */
    readonly startTime: string | null,
    readonly endTime: string | null,
    /** IANA identifier, e.g. `Asia/Riyadh`. Never hard-coded (ADR-0015). */
    readonly timezone: string,
  ) {
    Object.freeze(this);
  }

  static create(input: {
    date: string;
    startTime?: string | null;
    endTime?: string | null;
    timezone: string;
  }): Result<EventDateTime, EventDateTimeIssue> {
    if (!DATE_PATTERN.test(input.date)) return err('INVALID_DATE');

    // Rejects impossible calendar dates such as 2026-02-30, which match the
    // pattern but do not exist.
    const [year, month, day] = input.date.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return err('INVALID_DATE');
    }

    const startTime = input.startTime ?? null;
    const endTime = input.endTime ?? null;

    if (startTime !== null && !TIME_PATTERN.test(startTime)) return err('INVALID_TIME');
    if (endTime !== null && !TIME_PATTERN.test(endTime)) return err('INVALID_TIME');
    if (endTime !== null && startTime === null) return err('INVALID_TIME');
    // An end before a start is legitimate — a reception running past midnight —
    // so it is only rejected when both fall on the same declared date.
    if (startTime !== null && endTime !== null && endTime < startTime) {
      return err('END_BEFORE_START');
    }
    if (!isKnownTimezone(input.timezone)) return err('UNKNOWN_TIMEZONE');

    return ok(new EventDateTime(input.date, startTime, endTime, input.timezone));
  }

  /**
   * The UTC instant this event starts.
   *
   * When no time is given, midnight local time is used, which is what a
   * date-only countdown should count toward.
   */
  toInstant(): Date {
    const [year, month, day] = this.date.split('-').map(Number) as [number, number, number];
    const [hour, minute] = this.startTime
      ? (this.startTime.split(':').map(Number) as [number, number])
      : [0, 0];
    return wallClockToInstant(year, month, day, hour, minute, this.timezone);
  }

  hasPassed(now: Date): boolean {
    return this.toInstant().getTime() <= now.getTime();
  }

  /**
   * Milliseconds remaining until the event.
   *
   * Takes `now` as an argument rather than reading the clock: the countdown on
   * the public page is corrected against server time because phone clocks are
   * often wrong (docs/04-api-specification.md §4).
   */
  millisecondsUntil(now: Date): number {
    return Math.max(0, this.toInstant().getTime() - now.getTime());
  }

  toJSON(): {
    date: string;
    startTime: string | null;
    endTime: string | null;
    timezone: string;
  } {
    return {
      date: this.date,
      startTime: this.startTime,
      endTime: this.endTime,
      timezone: this.timezone,
    };
  }
}

export interface CountdownParts {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly totalMilliseconds: number;
}

/**
 * Splits a remaining duration into display units.
 *
 * Operates on an instant difference, never on formatted strings — string-based
 * date arithmetic is exactly how off-by-one-hour countdown bugs appear.
 */
export function countdownParts(target: Date, now: Date): CountdownParts {
  const totalMilliseconds = Math.max(0, target.getTime() - now.getTime());
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalMilliseconds,
  };
}

// ── server clock correction (D6.9) ──────────────────────────────────────────

/**
 * Below this, a difference is not worth correcting.
 *
 * Some of the gap between the two clocks is simply the time the response spent
 * in flight, and chasing that produces a countdown that twitches by a second
 * for no reason a guest could perceive.
 */
const SKEW_TOLERANCE_MS = 2_000;

/**
 * How far a visitor's device clock is from ours.
 *
 * Phone clocks are wrong far more often than anyone expects — manually set,
 * stuck after a flat battery, or in the wrong time zone with the date dragged
 * along. A countdown driven by an uncorrected device clock is the most visible
 * possible bug: an invitation that says the wedding was yesterday.
 *
 * Positive means the device is behind us.
 */
export function clockSkew(serverNow: Date, clientNow: Date): number {
  const difference = serverNow.getTime() - clientNow.getTime();
  return Math.abs(difference) < SKEW_TOLERANCE_MS ? 0 : difference;
}

/**
 * The device clock, corrected.
 *
 * The skew is measured once when the page loads and then *added* to each
 * subsequent device reading, rather than the server time being extrapolated on
 * its own. The device's monotonic-ish ticking is the reliable part; only its
 * absolute offset is suspect, so correcting the offset and trusting the ticks
 * is what keeps the countdown both right and smooth.
 */
export function correctedNow(clientNow: Date, skewMilliseconds: number): Date {
  return new Date(clientNow.getTime() + skewMilliseconds);
}
