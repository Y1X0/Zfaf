import { describe, expect, it } from 'vitest';

import {
  RSVP_PARTY_SIZE_MAX,
  checkRsvpPolicy,
  counterDelta,
  normaliseName,
  normalisePhone,
  parseRsvpSubmission,
  rsvpDedupeHash,
} from './rsvp-submission.js';
import { csvCell, rsvpCsv, toCsv } from './rsvp-csv.js';

const NOW = new Date('2026-08-16T10:00:00.000Z');

function submission(overrides: Record<string, unknown> = {}) {
  const parsed = parseRsvpSubmission({
    name: 'خالد العتيبي',
    attending: true,
    partySize: 3,
    phone: null,
    note: null,
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.submission;
}

// ── parsing ─────────────────────────────────────────────────────────────────

describe('parseRsvpSubmission', () => {
  it('accepts what a JSON client sends', () => {
    const parsed = parseRsvpSubmission({
      name: 'خالد',
      attending: true,
      partySize: 2,
      phone: '+966501234567',
      note: 'سنصل متأخرين',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.submission.attending).toBe(true);
  });

  it('accepts what a native HTML form sends', () => {
    // Every field arrives as a string from a form post, and the same endpoint
    // serves both — the public page has no framework to normalise it first
    // (ADR-0020).
    const parsed = parseRsvpSubmission({
      name: 'خالد',
      attending: 'yes',
      partySize: '2',
      phone: '',
      note: '',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.submission.attending).toBe(true);
    expect(parsed.submission.partySize).toBe(2);
    // Empty strings from an untouched form are absent values, not empty ones.
    expect(parsed.submission.phone).toBeNull();
    expect(parsed.submission.note).toBeNull();
  });

  it('reads a declining guest from either encoding', () => {
    for (const value of ['no', false, 'false']) {
      const parsed = parseRsvpSubmission({ name: 'خالد', attending: value, partySize: 1 });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.submission.attending).toBe(false);
    }
  });

  it('refuses a name too short to be one', () => {
    expect(parseRsvpSubmission({ name: 'خ', attending: true, partySize: 1 }).ok).toBe(false);
  });

  it('refuses a party larger than any wedding allows', () => {
    const parsed = parseRsvpSubmission({
      name: 'خالد',
      attending: true,
      partySize: RSVP_PARTY_SIZE_MAX + 1,
    });
    expect(parsed.ok).toBe(false);
  });

  it('refuses fields nobody asked for', () => {
    // `.strict()`: a client cannot smuggle `source: 'manual'` or an id past the
    // schema and have a later layer trust it.
    const parsed = parseRsvpSubmission({
      name: 'خالد',
      attending: true,
      partySize: 1,
      source: 'manual',
    });
    expect(parsed.ok).toBe(false);
  });

  it('reports translated keys, not English sentences', () => {
    const parsed = parseRsvpSubmission({ name: '', attending: true, partySize: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]?.messageKey).toMatch(/^rsvp\.invalid\./);
  });
});

// ── identity ────────────────────────────────────────────────────────────────

describe('guest identity', () => {
  it('treats the Arabic spellings of one name as one person', () => {
    // Arabic keyboards produce these interchangeably; two rows for one guest
    // would inflate the count the couple caters from.
    expect(normaliseName('أحمد')).toBe(normaliseName('احمد'));
    expect(normaliseName('سارة')).toBe(normaliseName('ساره'));
    expect(normaliseName('  خالد   العتيبي ')).toBe(normaliseName('خالد العتيبي'));
  });

  it('keeps genuinely different names apart', () => {
    expect(normaliseName('خالد')).not.toBe(normaliseName('محمد'));
  });

  it('reads one phone number written several ways as one number', () => {
    expect(normalisePhone('+966501234567')).toBe(normalisePhone('0501234567'));
    expect(normalisePhone('+966 50 123 4567')).toBe(normalisePhone('0501234567'));
  });

  it('produces one hash for a guest who double-taps submit', () => {
    const first = rsvpDedupeHash({ invitationId: 'inv-1', name: 'خالد العتيبي', phone: null });
    const second = rsvpDedupeHash({ invitationId: 'inv-1', name: 'خالد  العتيبي ', phone: null });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('does not merge the same guest across two weddings', () => {
    const here = rsvpDedupeHash({ invitationId: 'inv-1', name: 'خالد', phone: null });
    const there = rsvpDedupeHash({ invitationId: 'inv-2', name: 'خالد', phone: null });
    expect(Buffer.from(here).equals(Buffer.from(there))).toBe(false);
  });

  it('separates two guests who share a name but not a number', () => {
    const one = rsvpDedupeHash({ invitationId: 'inv-1', name: 'محمد', phone: '0501111111' });
    const two = rsvpDedupeHash({ invitationId: 'inv-1', name: 'محمد', phone: '0502222222' });
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
  });
});

// ── the invitation's rules ──────────────────────────────────────────────────

describe('checkRsvpPolicy', () => {
  const base = {
    enabled: true,
    deadline: null,
    maxPartySize: 5,
    now: NOW,
    timezone: 'Asia/Riyadh',
  };

  it('accepts a response within the rules', () => {
    expect(checkRsvpPolicy({ ...base, submission: submission() })).toBeNull();
  });

  it('refuses when the couple turned RSVP off', () => {
    expect(checkRsvpPolicy({ ...base, enabled: false, submission: submission() })).toBe(
      'RSVP_DISABLED',
    );
  });

  it('refuses a party larger than the couple allowed', () => {
    // The form carries the limit as a hint; this is where it is enforced,
    // from the published snapshot, on every submission.
    expect(checkRsvpPolicy({ ...base, submission: submission({ partySize: 6 }) })).toBe(
      'PARTY_TOO_LARGE',
    );
  });

  it('refuses "attending, with nobody"', () => {
    expect(checkRsvpPolicy({ ...base, submission: submission({ partySize: 0 }) })).toBe(
      'ATTENDING_NEEDS_GUESTS',
    );
  });

  it('lets a declining guest give any party size, including none', () => {
    const declining = submission({ attending: false, partySize: 0 });
    expect(checkRsvpPolicy({ ...base, submission: declining })).toBeNull();
  });

  it('keeps replies open until the end of the deadline day, in the wedding’s zone', () => {
    // Riyadh is UTC+3. A deadline of the 15th must still accept a reply at
    // 23:00 local — comparing instants would close it at 03:00 that morning.
    const lateOnTheDay = new Date('2026-09-15T20:00:00.000Z'); // 23:00 in Riyadh
    expect(
      checkRsvpPolicy({
        ...base,
        deadline: '2026-09-15',
        now: lateOnTheDay,
        submission: submission(),
      }),
    ).toBeNull();
  });

  it('closes replies once the deadline day is over there', () => {
    const nextMorning = new Date('2026-09-15T21:30:00.000Z'); // 00:30 on the 16th
    expect(
      checkRsvpPolicy({
        ...base,
        deadline: '2026-09-15',
        now: nextMorning,
        submission: submission(),
      }),
    ).toBe('DEADLINE_PASSED');
  });

  it('does not close replies early when the zone is unrecognisable', () => {
    // A bad zone is our problem, not the guest's; failing open here loses
    // nothing, while failing closed silently rejects real replies.
    expect(
      checkRsvpPolicy({
        ...base,
        timezone: 'Not/AZone',
        deadline: '2026-09-15',
        now: new Date('2026-09-15T12:00:00.000Z'),
        submission: submission(),
      }),
    ).toBeNull();
  });
});

// ── counters ────────────────────────────────────────────────────────────────

describe('counterDelta', () => {
  it('counts a new attending guest and their party', () => {
    expect(counterDelta(null, { attending: true, partySize: 3 })).toEqual({
      yes: 1,
      no: 0,
      guests: 3,
    });
  });

  it('counts a declining guest without adding to the head count', () => {
    expect(counterDelta(null, { attending: false, partySize: 0 })).toEqual({
      yes: 0,
      no: 1,
      guests: 0,
    });
  });

  it('moves a guest who changes their mind, without double counting', () => {
    expect(
      counterDelta({ attending: true, partySize: 3 }, { attending: false, partySize: 0 }),
    ).toEqual({ yes: -1, no: 1, guests: -3 });
  });

  it('adjusts only the head count when the party size changes', () => {
    expect(
      counterDelta({ attending: true, partySize: 2 }, { attending: true, partySize: 4 }),
    ).toEqual({ yes: 0, no: 0, guests: 2 });
  });

  it('is a no-op for an identical resubmission', () => {
    // The double-tap case: the same answer twice must not move anything.
    expect(
      counterDelta({ attending: true, partySize: 3 }, { attending: true, partySize: 3 }),
    ).toEqual({ yes: 0, no: 0, guests: 0 });
  });
});

// ── export ──────────────────────────────────────────────────────────────────

describe('CSV export', () => {
  it('defuses a name Excel would run as a formula', () => {
    // The attack: a guest types this as their name, the couple opens the guest
    // list, and it executes on their laptop.
    expect(csvCell("=cmd|'/c calc'!A0")).toBe("\"'=cmd|'/c calc'!A0\"");
  });

  it('defuses every character Excel treats as a formula start', () => {
    for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
      const cell = csvCell(`${trigger}danger`);
      expect(cell.startsWith('"\'') || cell.startsWith("'")).toBe(true);
    }
  });

  it('leaves an ordinary Arabic name exactly as typed', () => {
    expect(csvCell('خالد العتيبي')).toBe('خالد العتيبي');
  });

  it('quotes a value that would otherwise break the row apart', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('starts with a byte-order mark, or Excel renders Arabic as mojibake', () => {
    const csv = toCsv([{ a: 'خالد' }], [{ header: 'الاسم', value: (row) => row.a }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('separates rows the way RFC 4180 and Excel expect', () => {
    const csv = toCsv([{ a: '1' }, { a: '2' }], [{ header: 'n', value: (row) => row.a }]);
    expect(csv).toContain('\r\n');
  });

  it('writes the couple’s own language in the header row', () => {
    const row = {
      name: 'خالد',
      attending: true,
      partySize: 2,
      phone: null,
      note: null,
      submittedAt: NOW,
      source: 'public',
    };
    expect(rsvpCsv([row], 'ar')).toContain('الاسم');
    expect(rsvpCsv([row], 'ar')).toContain('نعم');
    expect(rsvpCsv([row], 'en')).toContain('Name');
    expect(rsvpCsv([row], 'en')).toContain('Yes');
  });

  it('never exports a credential', () => {
    // The export row type has no dedupe hash and no edit token, so a column
    // for one cannot be added by accident.
    const csv = rsvpCsv(
      [
        {
          name: 'خالد',
          attending: true,
          partySize: 1,
          phone: '0501234567',
          note: null,
          submittedAt: NOW,
          source: 'public',
        },
      ],
      'ar',
    );
    expect(csv.toLowerCase()).not.toContain('token');
    expect(csv.toLowerCase()).not.toContain('hash');
  });
});
