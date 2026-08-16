import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  REDACTED_KEY_FRAGMENTS,
  redact,
  redactFields,
  redactString,
  shouldRedactKey,
} from './redaction.js';

/**
 * The redaction layer (docs/15 §2 — *"tested by a unit test"*, explicitly).
 *
 * The banned list in the doc is the specification, so each of its entries gets
 * an assertion here rather than a summary. What a leak of this kind costs is
 * asymmetric: nobody notices the over-redacted field, and everybody notices the
 * session token in a log aggregator that a support contractor can search.
 */

describe('the categories docs/15 §2 forbids outright', () => {
  it.each([
    ['password', 'hunter2'],
    ['passwordHash', '$argon2id$v=19$...'],
    ['sessionToken', 'abc123'],
    ['session_id', 'sess-1'],
    ['authorization', 'Bearer abc'],
    ['cookie', '__Host-zfaf_session=x'],
    ['apiKey', 'sk_live_123'],
    ['api_key', 'sk_live_123'],
    ['secret', 'shh'],
    ['privateKey', '-----BEGIN'],
    ['cardNumber', '4111111111111111'],
    ['cvv', '123'],
    ['iban', 'SA0380000000608010167519'],
    ['otp', '123456'],
    ['totpSecret', 'JBSWY3DP'],
    ['recoveryCode', 'ABCDE-FGHJK'],
    ['guestName', 'خالد'],
    ['guest_name', 'خالد'],
    ['phone', '+966501234567'],
    ['mobile', '+966501234567'],
  ])('redacts %s whatever it holds', (key, value) => {
    expect(redactFields({ [key]: value })[key]).toBe(REDACTED);
  });

  it('redacts by substring, so casing and separators cannot slip past', () => {
    for (const key of ['SESSION_TOKEN', 'userPassword', 'x-api-key', 'refreshToken']) {
      expect(shouldRedactKey(key)).toBe(true);
    }
  });

  it('keeps the hashes that exist precisely so they can be used', () => {
    // ADR-0009: the whole point of an ipHash is that it is loggable.
    const fields = redactFields({ ipHash: 'a1b2c3', tokenHash: 'd4e5f6', visitorHash: 'g7h8' });
    expect(fields).toEqual({ ipHash: 'a1b2c3', tokenHash: 'd4e5f6', visitorHash: 'g7h8' });
  });
});

describe('values that identify a person, wherever they appear', () => {
  it('shortens an email but keeps the domain', () => {
    // "all the failures are from one mail provider" must stay answerable.
    expect(redactString('login failed for sarah@example.com')).toBe(
      'login failed for s***@example.com',
    );
  });

  it('redacts a raw IP address', () => {
    expect(redactString('from 192.168.10.24')).toBe(`from ${REDACTED}`);
  });

  it('redacts a phone number in the formats people write them in', () => {
    for (const number of ['+966 50 123 4567', '00966501234567', '+966-50-123-4567']) {
      expect(redactString(`called ${number}`)).toContain(REDACTED);
      expect(redactString(`called ${number}`)).not.toContain('501234567');
    }
  });

  it('redacts a long opaque blob, which is what a leaked token looks like', () => {
    const token = 'a'.repeat(48);
    expect(redactString(`Bearer ${token}`)).toBe(`Bearer ${REDACTED}`);
  });

  it('leaves ordinary prose alone', () => {
    const message = 'invitation published in 342ms after 2 retries';
    expect(redactString(message)).toBe(message);
  });

  it('does not mistake a version number for an address', () => {
    expect(redactString('next 15.5.23 on node 22')).toBe('next 15.5.23 on node 22');
  });
});

describe('the shape of the thing being logged', () => {
  it('reaches into nested objects', () => {
    const fields = redactFields({
      request: { headers: { authorization: 'Bearer x' }, path: '/api/v1/invitations' },
    });
    expect(fields).toEqual({
      request: { headers: { authorization: REDACTED }, path: '/api/v1/invitations' },
    });
  });

  it('reaches into arrays', () => {
    expect(redactFields({ users: [{ email: 'a@b.com' }, { email: 'c@d.com' }] })).toEqual({
      users: [{ email: 'a***@b.com' }, { email: 'c***@d.com' }],
    });
  });

  it('redacts an error’s message and stack, where a secret usually survives', () => {
    const error = new Error('failed for sarah@example.com');
    const redacted = redact(error) as { message: string; stack?: string };
    expect(redacted.message).toBe('failed for s***@example.com');
    expect(redacted.stack ?? '').not.toContain('sarah@example.com');
  });

  it('summarises binary rather than printing it', () => {
    expect(redact(new Uint8Array(32))).toBe('[32 bytes]');
  });

  it('stops at a bounded depth rather than recursing forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    // The assertion that matters is that this returns at all.
    expect(() => redactFields(cyclic)).not.toThrow();
  });

  it('bounds how much of a large structure it will process', () => {
    const big = { items: Array.from({ length: 500 }, (_, index) => index) };
    expect((redactFields(big)['items'] as unknown[]).length).toBe(100);
  });

  it('never emits a function or a symbol', () => {
    expect(redactFields({ callback: () => {}, marker: Symbol('x') })).toEqual({
      callback: REDACTED,
      marker: REDACTED,
    });
  });

  it('keeps the primitives a log line is actually made of', () => {
    expect(redactFields({ durationMs: 342, ok: true, count: 0n })).toEqual({
      durationMs: 342,
      ok: true,
      count: '0',
    });
  });

  it('handles no fields at all', () => {
    expect(redactFields(undefined)).toEqual({});
  });
});

describe('the denylist itself', () => {
  it('covers every category docs/15 §2 names', () => {
    // A reviewer should be able to read the list next to the doc and compare.
    for (const fragment of ['password', 'token', 'secret', 'card', 'phone', 'guestname']) {
      expect(REDACTED_KEY_FRAGMENTS).toContain(fragment);
    }
  });
});
