import {
  type ErrorTracker,
  type Logger,
  type TrackedError,
  redact,
  redactString,
} from '@zfaf/core';

/**
 * Error reporting to Sentry over its ingest API (docs/15 §3).
 *
 * Written against the HTTP envelope rather than the vendor SDK, and the reason
 * is the scrubbing requirement. docs/15 marks `beforeSend` scrubbing
 * "⚠️ إلزامي" — mandatory — and an SDK's `beforeSend` hook is a callback
 * somebody can later remove, reorder, or bypass with a direct `captureMessage`.
 * Here the redaction is not a hook: the payload is *built* from redacted values
 * and there is no other path to the wire. The SDK also brings automatic
 * instrumentation that would capture request bodies and breadcrumbs we have
 * spent four milestones keeping out of logs.
 *
 * What is given up: performance tracing, release health, and automatic
 * breadcrumbs. None of those is on the M10 list, and each can be added
 * deliberately later rather than arriving by default with data attached.
 */

interface ParsedDsn {
  readonly endpoint: string;
  readonly publicKey: string;
  readonly projectId: string;
}

/**
 * Parses a DSN into the ingest URL.
 *
 * Returns null rather than throwing on a malformed value: a bad DSN must
 * degrade to "errors are not reported anywhere" — which the health surface
 * shows — and never to "the process will not start".
 */
export function parseSentryDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !projectId) return null;
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
      projectId,
    };
  } catch {
    return null;
  }
}

export interface SentryOptions {
  readonly dsn: string;
  readonly environment: string;
  readonly release?: string;
  readonly serverName?: string;
  /** Where a delivery failure goes. Never thrown at the caller. */
  readonly logger?: Logger;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export class SentryErrorTracker implements ErrorTracker {
  private readonly dsn: ParsedDsn | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(private readonly options: SentryOptions) {
    this.dsn = parseSentryDsn(options.dsn);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** True when a usable DSN was configured. Read by the deep health check. */
  get configured(): boolean {
    return this.dsn !== null;
  }

  capture(input: TrackedError): void {
    if (!this.dsn) return;

    /**
     * Fire and forget, and swallow everything.
     *
     * `capture` is called from catch blocks. A rejected promise here would
     * become an unhandled rejection during an incident — the moment when the
     * process can least afford a second failure.
     */
    void this.send(input).catch(() => {});
  }

  private async send(input: TrackedError): Promise<void> {
    if (!this.dsn) return;

    const error = input.error;
    const isError = error instanceof Error;

    const event = {
      event_id: randomEventId(),
      timestamp: this.now().toISOString(),
      platform: 'node',
      level: input.level ?? 'error',
      environment: this.options.environment,
      ...(this.options.release ? { release: this.options.release } : {}),
      ...(this.options.serverName ? { server_name: this.options.serverName } : {}),
      logger: input.event,
      exception: {
        values: [
          {
            type: isError ? error.name : 'UnknownError',
            // Redacted, not merely trimmed: an interpolated address or token in
            // an error message is the most common way one reaches a vendor.
            value: redactString(isError ? error.message : String(error)),
            stacktrace: isError && error.stack ? { frames: framesFrom(error.stack) } : undefined,
          },
        ],
      },
      // Every custom field goes through the same redactor the logger uses.
      extra: redact(input.fields ?? {}),
      tags: { event: input.event },
    };

    const header = JSON.stringify({ event_id: event.event_id, sent_at: event.timestamp });
    const itemHeader = JSON.stringify({ type: 'event' });
    const body = `${header}\n${itemHeader}\n${JSON.stringify(event)}\n`;

    const response = await this.fetchImpl(this.dsn.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=zfaf/1`,
      },
      body,
    });

    if (!response.ok) {
      // Logged, not thrown. "We could not report an error" is itself worth a
      // line, and it is the line that explains a silent Sentry dashboard.
      this.options.logger?.warn('observability.sentry_delivery_failed', {
        status: response.status,
      });
    }
  }
}

/**
 * Turns a stack into Sentry's frame list.
 *
 * Deliberately shallow — file, line and function only. Sentry's SDK attaches
 * local variables and source context on some platforms; a local variable is
 * exactly where a decrypted secret or a guest's name lives at the moment an
 * exception is thrown.
 */
function framesFrom(
  stack: string,
): Array<{ filename: string; function?: string; lineno?: number }> {
  return stack
    .split('\n')
    .slice(1, 30)
    .map((line) => {
      const match = /at (?:(.+?) )?\(?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
      if (!match) return { filename: redactString(line.trim()) };
      return {
        filename: match[2] ?? '',
        ...(match[1] ? { function: match[1] } : {}),
        lineno: Number(match[3]),
      };
    })
    .reverse();
}

/** 32 lowercase hex characters, as the envelope format requires. */
function randomEventId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The tracker to use when no DSN is configured.
 *
 * Writes the error through the logger instead of discarding it, so a
 * development or self-hosted deployment without Sentry still has the error
 * somewhere — which a silent no-op would not.
 */
export class LoggingErrorTracker implements ErrorTracker {
  constructor(private readonly logger: Logger) {}

  capture(input: TrackedError): void {
    this.logger.error(input.event, { ...input.fields, error: input.error });
  }
}
