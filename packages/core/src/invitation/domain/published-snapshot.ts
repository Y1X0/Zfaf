import { z } from 'zod';

import { ThemeSchema } from '../../template/domain/theme.js';
import { SectionInstanceSchema } from '../../template/domain/section.js';

/**
 * The immutable published representation (ADR-0005).
 *
 * Immutability here is a domain invariant, not a UI convention. It is enforced
 * in three independent places, because any one of them can be bypassed:
 *
 *   1. Types — `PublishedSnapshot` is deeply readonly.
 *   2. Runtime — `createSnapshot` deep-freezes the object it returns.
 *   3. Database — a trigger rejects UPDATE and DELETE on `invitation_versions`.
 *
 * The third is the one that actually holds: types vanish at runtime and a
 * frozen object says nothing about a raw SQL statement issued from elsewhere.
 *
 * There is deliberately no `updateSnapshot` anywhere in the domain API. The
 * only way to change what guests see is to edit the draft and publish again,
 * producing a new version.
 */

/** A media reference already resolved to an absolute URL at publish time. */
export const ResolvedMediaSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    blurhash: z.string().nullable(),
    alt: z.string().max(300).nullable(),
  })
  .strict();

export const ResolvedEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['contract', 'reception', 'wedding', 'dinner', 'custom']),
    title: z.string().min(1).max(120),
    description: z.string().max(1000).nullable(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    endTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    timezone: z.string().min(1),
    venueName: z.string().max(200).nullable(),
    venueAddress: z.string().max(500).nullable(),
    mapsUrl: z.string().url().nullable(),
    sortOrder: z.number().int(),
  })
  .strict();

export const PublishedSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),

    templateKey: z.string().min(1),
    /** Frozen at publish time so a later template release cannot alter this invitation. */
    templateVersion: z.number().int().positive(),

    locale: z.enum(['ar', 'en']),
    /** The invitation's own time zone, carried so rendering never guesses. */
    timezone: z.string().min(1),

    /** Fully resolved — no partial overrides left to merge at render time. */
    theme: ThemeSchema,
    sections: z.array(SectionInstanceSchema).max(30),

    content: z
      .object({
        couple: z
          .object({
            groomName: z.string().min(1).max(80),
            brideName: z.string().min(1).max(80),
            shortName: z.string().max(40).nullable(),
            message: z.string().max(2000).nullable(),
            photo: ResolvedMediaSchema.nullable(),
          })
          .strict(),
        wedding: z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            startTime: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .nullable(),
            endTime: z
              .string()
              .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
              .nullable(),
            timezone: z.string().min(1),
          })
          .strict(),
        location: z
          .object({
            venueName: z.string().max(200).nullable(),
            address: z.string().max(500).nullable(),
            latitude: z.number().min(-90).max(90).nullable(),
            longitude: z.number().min(-180).max(180).nullable(),
            mapsUrl: z.string().url().nullable(),
          })
          .strict(),
        events: z.array(ResolvedEventSchema).max(20),
        cover: ResolvedMediaSchema.nullable(),
        gallery: z.array(ResolvedMediaSchema).max(60),
        music: z
          .object({
            trackId: z.string().nullable(),
            url: z.string().url().nullable(),
            title: z.string().max(200).nullable(),
            attribution: z.string().max(500).nullable(),
          })
          .strict(),
        rsvp: z
          .object({
            enabled: z.boolean(),
            deadline: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullable(),
            maxPartySize: z.number().int().min(0).max(50),
          })
          .strict(),
      })
      .strict(),

    publishedAt: z.string().datetime(),
  })
  .strict();

export type PublishedSnapshot = Readonly<z.infer<typeof PublishedSnapshotSchema>>;

/**
 * Recursively freezes a value.
 *
 * `Object.freeze` is shallow; a snapshot's nested arrays and objects would stay
 * mutable, which is precisely where an accidental in-place edit would land.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export type SnapshotValidationError = {
  readonly path: string;
  readonly message: string;
};

/**
 * The only way to obtain a `PublishedSnapshot`.
 *
 * Validates and then freezes. A snapshot that fails validation is never
 * created, so a malformed document cannot reach the public page — the failure
 * happens at publish time, when the owner is present to fix it, rather than at
 * render time in front of guests.
 */
export function createSnapshot(
  input: unknown,
): { ok: true; snapshot: PublishedSnapshot } | { ok: false; errors: SnapshotValidationError[] } {
  const parsed = PublishedSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }
  return { ok: true, snapshot: deepFreeze(parsed.data) as PublishedSnapshot };
}

/**
 * Reconstructs a snapshot read back from storage.
 *
 * Re-validates rather than trusting the row: a snapshot written by an older
 * schema version, or altered outside the application, must not render.
 */
export function readSnapshot(
  stored: unknown,
): { ok: true; snapshot: PublishedSnapshot } | { ok: false; errors: SnapshotValidationError[] } {
  return createSnapshot(stored);
}
