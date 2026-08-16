import {
  LOG_LEVEL_ORDER,
  type LogFields,
  type LogLevel,
  type Logger,
  redactFields,
} from '@zfaf/core';

/**
 * One JSON object per line, on stdout (docs/15 §2).
 *
 * Not a logging library, and that is a decision rather than an omission. What
 * a library buys is transports, formatters and level plumbing; what this needs
 * is a stable field set and a redaction pass that cannot be bypassed. A
 * dependency would give us the first and make the second optional.
 *
 * **Redaction is not a formatter here.** It runs inside `write`, before
 * serialisation, on every line, with no flag to disable it. A caller cannot opt
 * out, because the leak this prevents always comes from a caller who did not
 * mean to.
 */

export interface JsonLoggerOptions {
  /** Below this level, nothing is written. `debug` is disabled in production. */
  readonly level?: LogLevel;
  /** Which process wrote the line: `web`, `worker`. */
  readonly service?: string;
  readonly env?: string;
  readonly version?: string;
  /** Injected so tests can capture output instead of racing stdout. */
  readonly sink?: (line: string) => void;
  /** Injected for the same reason `Clock` is a port. */
  readonly now?: () => Date;
}

export class JsonLogger implements Logger {
  private readonly floor: number;
  private readonly base: LogFields;
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;
  private readonly options: JsonLoggerOptions;

  constructor(options: JsonLoggerOptions = {}, base: LogFields = {}) {
    this.options = options;
    this.floor = LOG_LEVEL_ORDER[options.level ?? 'info'];
    this.base = base;
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
  }

  debug(event: string, fields?: LogFields): void {
    this.write('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  /** A logger carrying extra fields — a request id, typically. */
  child(fields: LogFields): Logger {
    return new JsonLogger(this.options, { ...this.base, ...fields });
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LOG_LEVEL_ORDER[level] < this.floor) return;

    const line = {
      // The standard fields from docs/15 §2, in a fixed order so a human
      // scanning raw output sees the same shape every time.
      timestamp: this.now().toISOString(),
      level,
      event,
      service: this.options.service ?? 'web',
      env: this.options.env ?? process.env['NODE_ENV'] ?? 'development',
      ...(this.options.version ? { version: this.options.version } : {}),
      ...redactFields({ ...this.base, ...fields }),
    };

    try {
      this.sink(JSON.stringify(line));
    } catch {
      /**
       * A log line must never take a request down.
       *
       * `JSON.stringify` throws on a circular structure the redactor did not
       * flatten, and on a BigInt that slipped past it. Losing one line is the
       * correct outcome; throwing from inside a catch block that was reporting
       * an error is not.
       */
    }
  }
}
