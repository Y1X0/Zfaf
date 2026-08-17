import { describe, expect, it } from 'vitest';

import { REDACTED } from '@zfaf/core';

import { JsonLogger } from './json-logger.js';
import { LoggingErrorTracker, SentryErrorTracker, parseSentryDsn } from './sentry-error-tracker.js';

/**
 * The logging and error-reporting adapters (docs/15 §2, §3).
 *
 * The assertions that matter here are the negative ones. That a line is
 * written is easy; that a session token cannot reach the line, and cannot
 * reach a third-party vendor, is the property four milestones of care depend
 * on.
 */

const NOW = new Date('2026-08-16T12:00:00.000Z');

function capturing(options: Record<string, unknown> = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => NOW,
    ...options,
  });
  return { logger, lines };
}

describe('the standard field set', () => {
  it('carries every field docs/15 §2 names', () => {
    const { logger, lines } = capturing({ service: 'web', env: 'production', version: 'abc123' });
    logger.info('invitation.published', { invitationId: 'inv-1', durationMs: 342 });

    expect(lines[0]).toEqual({
      timestamp: NOW.toISOString(),
      level: 'info',
      event: 'invitation.published',
      service: 'web',
      env: 'production',
      version: 'abc123',
      invitationId: 'inv-1',
      durationMs: 342,
    });
  });

  it('writes one JSON object per line, so a collector can parse it', () => {
    const written: string[] = [];
    const logger = new JsonLogger({ sink: (line) => written.push(line), now: () => NOW });
    logger.info('a');
    logger.warn('b');

    expect(written).toHaveLength(2);
    for (const line of written) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('adds a child’s fields to every line without mutating the parent', () => {
    const { logger, lines } = capturing();
    const request = logger.child({ requestId: 'req-1' });
    request.info('rsvp.submitted');
    logger.info('unrelated');

    expect(lines[0]).toMatchObject({ requestId: 'req-1' });
    expect(lines[1]).not.toHaveProperty('requestId');
  });
});

describe('levels', () => {
  it('drops everything below the configured floor', () => {
    const { logger, lines } = capturing({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((line) => line['level'])).toEqual(['warn', 'error']);
  });

  it('disables debug at the default floor, as production requires', () => {
    const { logger, lines } = capturing();
    logger.debug('should not appear');
    expect(lines).toHaveLength(0);
  });
});

describe('redaction is not optional', () => {
  it('applies to fields, with no way for a caller to skip it', () => {
    const { logger, lines } = capturing();
    logger.info('auth.login_succeeded', {
      sessionToken: 'abc123',
      email: 'sarah@example.com',
      ipHash: 'a1b2c3',
    });

    expect(lines[0]).toMatchObject({
      sessionToken: REDACTED,
      email: 's***@example.com',
      // The hash survives; it exists to be used (ADR-0009).
      ipHash: 'a1b2c3',
    });
  });

  it('applies to a child’s bound fields too', () => {
    const { logger, lines } = capturing();
    logger.child({ password: 'hunter2' }).info('anything');
    expect(lines[0]).toMatchObject({ password: REDACTED });
  });

  it('reaches into a nested structure', () => {
    const { logger, lines } = capturing();
    logger.warn('request.rejected', { headers: { authorization: 'Bearer x' } });
    expect(lines[0]).toMatchObject({ headers: { authorization: REDACTED } });
  });
});

describe('a log line never takes a request down', () => {
  it('drops a line it cannot serialise rather than throwing', () => {
    const logger = new JsonLogger({
      sink: () => {
        throw new Error('stdout is gone');
      },
    });
    expect(() => logger.error('anything')).not.toThrow();
  });
});

// ── error tracking ──────────────────────────────────────────────────────────

describe('the Sentry DSN', () => {
  it('parses into the envelope endpoint', () => {
    expect(parseSentryDsn('https://abc123@o1.ingest.sentry.io/456')).toEqual({
      endpoint: 'https://o1.ingest.sentry.io/api/456/envelope/',
      publicKey: 'abc123',
      projectId: '456',
    });
  });

  it.each(['', 'not-a-url', 'https://o1.ingest.sentry.io/456', 'https://abc@host/'])(
    'refuses %j rather than throwing at startup',
    (dsn) => {
      expect(parseSentryDsn(dsn)).toBeNull();
    },
  );

  it('reports itself unconfigured on a bad DSN, instead of failing to construct', () => {
    expect(new SentryErrorTracker({ dsn: 'nonsense', environment: 'test' }).configured).toBe(false);
  });
});

describe('what actually reaches Sentry', () => {
  /** Captures the envelope instead of sending it. */
  function intercepting() {
    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const tracker = new SentryErrorTracker({
      dsn: 'https://key@o1.ingest.sentry.io/456',
      environment: 'production',
      release: 'abc123',
      now: () => NOW,
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({
          url: String(url),
          body: String(init.body),
          headers: init.headers as Record<string, string>,
        });
        return new Response('', { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });
    return { tracker, sent };
  }

  /** The envelope's third line is the event itself. */
  const eventFrom = (body: string) =>
    JSON.parse(body.split('\n')[2] ?? '{}') as Record<string, unknown>;

  it('sends a well-formed envelope to the right endpoint', async () => {
    const { tracker, sent } = intercepting();
    tracker.capture({ error: new Error('boom'), event: 'publish.failed' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://o1.ingest.sentry.io/api/456/envelope/');
    expect(sent[0]!.headers['x-sentry-auth']).toContain('sentry_key=key');
    // header, item header, payload, trailing newline
    expect(sent[0]!.body.split('\n')).toHaveLength(4);
  });

  it('redacts the exception message', async () => {
    const { tracker, sent } = intercepting();
    tracker.capture({
      error: new Error('could not email sarah@example.com'),
      event: 'mail.failed',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent[0]!.body).not.toContain('sarah@example.com');
    expect(sent[0]!.body).toContain('s***@example.com');
  });

  it('redacts custom fields, so nothing reaches a vendor unscrubbed', async () => {
    const { tracker, sent } = intercepting();
    tracker.capture({
      error: new Error('boom'),
      event: 'rsvp.failed',
      fields: { sessionToken: 'abc', guestName: 'خالد', invitationId: 'inv-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const event = eventFrom(sent[0]!.body);
    expect(event['extra']).toMatchObject({
      sessionToken: REDACTED,
      guestName: REDACTED,
      invitationId: 'inv-1',
    });
  });

  it('sends frames without local variables or source context', async () => {
    const { tracker, sent } = intercepting();
    tracker.capture({ error: new Error('boom'), event: 'x.failed' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const event = eventFrom(sent[0]!.body);
    const frames = ((event['exception'] as { values: { stacktrace?: { frames: unknown[] } }[] })
      .values[0]!.stacktrace?.frames ?? []) as Record<string, unknown>[];

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      // A local variable is exactly where a decrypted secret lives when an
      // exception is thrown.
      expect(Object.keys(frame).sort()).toEqual(
        Object.keys(frame)
          .filter((key) => ['filename', 'function', 'lineno'].includes(key))
          .sort(),
      );
    }
  });

  it('sends nothing at all when no DSN is configured', async () => {
    let called = false;
    const tracker = new SentryErrorTracker({
      dsn: '',
      environment: 'test',
      fetch: (async () => {
        called = true;
        return new Response('');
      }) as unknown as typeof globalThis.fetch,
    });
    tracker.capture({ error: new Error('boom'), event: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(called).toBe(false);
  });

  it('never throws or rejects when delivery fails', async () => {
    const tracker = new SentryErrorTracker({
      dsn: 'https://key@o1.ingest.sentry.io/456',
      environment: 'test',
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    });

    expect(() => tracker.capture({ error: new Error('boom'), event: 'x' })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe('the fallback tracker', () => {
  it('writes the error through the logger, redacted, rather than dropping it', () => {
    const { logger, lines } = capturing();
    new LoggingErrorTracker(logger).capture({
      error: new Error('failed for sarah@example.com'),
      event: 'publish.failed',
      fields: { sessionToken: 'abc' },
    });

    expect(lines[0]).toMatchObject({ level: 'error', event: 'publish.failed' });
    expect(JSON.stringify(lines[0])).not.toContain('sarah@example.com');
    expect(lines[0]!['sessionToken']).toBe(REDACTED);
  });
});
