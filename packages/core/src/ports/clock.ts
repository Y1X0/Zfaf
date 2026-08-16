/**
 * Time as a dependency.
 *
 * Expiry, countdowns and publish timestamps are all time-dependent. Injecting
 * the clock keeps those use cases deterministic under test and keeps the
 * renderer pure — see docs/08-backend-architecture.md §3.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test double: a clock frozen at, and advanceable from, a fixed instant. */
export function fixedClock(instant: Date): Clock & { advance(ms: number): void } {
  let current = instant.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
