/**
 * Log redaction (docs/15 §2, docs/12 §11).
 *
 * The doc is unambiguous about why this exists: *"a redaction layer in the
 * logger blocks known keys before writing — we do not rely on developer
 * discipline alone."* Every leak of this kind in every system that has had one
 * came from a line somebody wrote in a hurry, usually while debugging the
 * incident. So the filter runs on the way out and knows nothing about who
 * called it.
 *
 * Two mechanisms, and both are needed:
 *
 *   • **Key names.** `password`, `token`, `secret` and their neighbours are
 *     replaced whatever they contain. This catches the common case and it
 *     catches it regardless of value shape.
 *   • **Value shapes.** An email address, a phone number or an IPv4 address is
 *     redacted wherever it appears — including inside a free-text `message`
 *     field that no key rule would ever match. This is what catches the
 *     interpolated string somebody logged at 2am.
 *
 * Guest names are the one category no automated rule can recognise, so they
 * are handled by not putting them in a log line at all — enforced by the tests
 * that assert on what specific use cases record, not by this function.
 */

/** What replaces a redacted value. Recognisable in a log, and never a real value. */
export const REDACTED = '[redacted]';

/**
 * Key names whose value never gets written, at any depth.
 *
 * The key is lower-cased and stripped of separators before matching, so
 * `sessionToken`, `session_token`, `SESSION-TOKEN` and `x-api-key` all reduce
 * to a form the list below covers. A substring rule over-redacts occasionally
 * — `tokenCount` loses its number — and that is the correct direction to be
 * wrong in.
 */
export const REDACTED_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'sessionid',
  'credential',
  'privatekey',
  'card',
  'cvv',
  'pan',
  'iban',
  'otp',
  'totp',
  'recoverycode',
  'phone',
  'mobile',
  'guestname',
] as const;

/**
 * Keys that carry an already-hashed value and are safe, despite matching above.
 *
 * `ipHash` is the whole point of ADR-0009: we keep a hash precisely so it can
 * be used. Redacting it would remove the one thing that makes a rate-limit
 * incident diagnosable.
 */
const ALLOWED_KEYS = new Set(['iphash', 'tokenhash', 'visitorhash']);

/** Lower case, letters and digits only — so separators cannot hide a match. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** Dotted quad, bounded so it does not eat version numbers like `1.2.3.4-rc`. */
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Long enough to be a real number, and tolerant of the ways they are written. */
const PHONE = /(?:\+|00)\d[\d\s-]{7,17}\d/g;
/** A bearer-ish blob: long, high-entropy, no spaces. */
const LONG_OPAQUE = /\b[A-Za-z0-9_-]{40,}\b/g;

export function shouldRedactKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (ALLOWED_KEYS.has(normalised)) return false;
  return REDACTED_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * Masks the patterns that identify a person, wherever they appear in a string.
 *
 * An email is *shortened* rather than removed: `a***@example.com` keeps the
 * domain, which is what makes "all the failures are from one mail provider"
 * answerable, while dropping the identity. docs/15 asks for exactly this —
 * "full email addresses (we hash or truncate them)".
 */
export function redactString(value: string): string {
  return value
    .replace(EMAIL, (match) => {
      const [local = '', domain = ''] = match.split('@');
      return `${local.slice(0, 1)}***@${domain}`;
    })
    .replace(PHONE, REDACTED)
    .replace(IPV4, REDACTED)
    .replace(LONG_OPAQUE, REDACTED);
}

/**
 * Redacts a whole structure, recursively.
 *
 * Depth- and breadth-bounded: a log call is not a place to spend unbounded
 * time, and a cyclic or enormous object reaching the logger is itself a bug
 * that should not also become an outage.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;

  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      // The stack is where an interpolated secret most often survives.
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      output[key] = shouldRedactKey(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }

  // Functions and symbols have no business in a log line.
  return REDACTED;
}

/** Redacts the fields of one log line. Always returns an object. */
export function redactFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!fields) return {};
  return redact(fields) as Record<string, unknown>;
}
