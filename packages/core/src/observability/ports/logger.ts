/**
 * Structured logging and error tracking ports (docs/15 §2, §3).
 *
 * Both are ports rather than direct calls for the ordinary reason — the domain
 * must not know whether logs go to stdout, Axiom or nowhere — and for one
 * specific reason: a use case that calls a logging *vendor* is a use case that
 * cannot be unit-tested without stubbing that vendor, and the tests that matter
 * most here are the ones asserting what a use case does **not** write.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric order, so a configured floor can be compared rather than matched. */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * The fields every line carries (docs/15 §2).
 *
 * `event` is a dotted name — `invitation.published`, `rsvp.submitted` — not a
 * sentence. A sentence is grep-able only until somebody rewords it; a name is
 * what a dashboard and an alert rule can be built on.
 */
export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds these fields to every line — a request id, typically. */
  child(fields: LogFields): Logger;
}

/**
 * A logger that discards everything.
 *
 * For tests and for the composition root before configuration is read. Named
 * so that a `NO_LOGGER` appearing in production code review is obvious.
 */
export const NO_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NO_LOGGER,
};

// ── error tracking ──────────────────────────────────────────────────────────

export interface TrackedError {
  readonly error: unknown;
  /** Dotted event name, matching the log line that accompanies it. */
  readonly event: string;
  readonly fields?: LogFields;
  readonly level?: 'warning' | 'error' | 'fatal';
}

export interface ErrorTracker {
  /**
   * Reports an error.
   *
   * Returns void and must never throw or reject: a failure to report an error
   * is not permitted to become a second error, and certainly not permitted to
   * fail the request that was already going badly.
   */
  capture(input: TrackedError): void;
}

export const NO_ERROR_TRACKER: ErrorTracker = { capture: () => {} };
