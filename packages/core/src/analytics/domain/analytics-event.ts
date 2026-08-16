import { z } from 'zod';

import { type DeviceClass, isDeviceClass } from './visitor-hash.js';

/**
 * What the public page is allowed to report (D8.2).
 *
 * One event type. The owner cut the MVP down to *Views · Unique · RSVP ·
 * device category* and deferred everything else (ADR-0009, amendment of
 * 2026-08-16): no referrer, no country, no time series, no `maps_click` or
 * `music_play`. Accepting those types "for later" would mean collecting data
 * we decided not to collect, which is the opposite of what that decision said.
 *
 * So the allowlist is one word long, and an unrecognised type is dropped —
 * silently, because the endpoint answers `204` to everything by design.
 */
export const ANALYTICS_EVENT_TYPES = ['view'] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/**
 * The beacon body.
 *
 * `slug`, not an invitation id. The visitor is already looking at the page the
 * slug names, so it tells the server nothing the visitor does not already
 * know — whereas putting an internal UUID into a public page would hand every
 * reader a durable identifier for a row in our database, and hand a scanner an
 * enumeration surface. The invitation id still goes into the visitor hash;
 * the server resolves it, the client never sees it.
 *
 * `.strict()` so an unexpected key is a refusal rather than a value quietly
 * ignored — the endpoint is public and its shape should not be negotiable.
 */
export const AnalyticsBeaconSchema = z
  .object({
    slug: z.string().trim().min(1).max(120),
    type: z.enum(ANALYTICS_EVENT_TYPES),
  })
  .strict();

export type AnalyticsBeacon = z.infer<typeof AnalyticsBeaconSchema>;

/** One event, resolved and ready to be counted. */
export interface PendingAnalyticsEvent {
  readonly invitationId: string;
  readonly type: AnalyticsEventType;
  readonly visitorHash: Uint8Array;
  readonly deviceClass: DeviceClass;
  readonly occurredAt: Date;
}

/**
 * The wire form used while an event waits in the buffer (D8.3).
 *
 * Deliberately terse and deliberately explicit. Terse because a busy
 * invitation can have thousands of these in flight and every byte is memory
 * in a shared Redis; explicit because the buffer is a boundary — what comes
 * back out of it is untrusted input again, and `decodeBufferedEvent` treats it
 * that way rather than casting.
 */
export interface BufferedAnalyticsEvent {
  /** invitation id */
  readonly i: string;
  /** event type */
  readonly t: AnalyticsEventType;
  /** visitor hash, hex */
  readonly v: string;
  /** device class */
  readonly d: DeviceClass;
  /** occurred at, epoch milliseconds */
  readonly o: number;
}

export function encodeBufferedEvent(event: PendingAnalyticsEvent): string {
  const encoded: BufferedAnalyticsEvent = {
    i: event.invitationId,
    t: event.type,
    v: bytesToHex(event.visitorHash),
    d: event.deviceClass,
    o: event.occurredAt.getTime(),
  };
  return JSON.stringify(encoded);
}

/**
 * Reads one buffered entry back.
 *
 * Returns `null` rather than throwing on anything unexpected: a single
 * corrupted entry — from a half-written value, or from a future version of
 * this encoding during a rolling deploy — must not abort a flush that is
 * carrying thousands of good ones.
 */
export function decodeBufferedEvent(raw: string): PendingAnalyticsEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;

  const { i, t, v, d, o } = value;
  if (typeof i !== 'string' || i.length === 0) return null;
  if (typeof t !== 'string' || !(ANALYTICS_EVENT_TYPES as readonly string[]).includes(t)) {
    return null;
  }
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) return null;
  if (typeof d !== 'string' || !isDeviceClass(d)) return null;
  if (typeof o !== 'number' || !Number.isFinite(o)) return null;

  return {
    invitationId: i,
    type: t as AnalyticsEventType,
    visitorHash: hexToBytes(v),
    deviceClass: d,
    occurredAt: new Date(o),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
