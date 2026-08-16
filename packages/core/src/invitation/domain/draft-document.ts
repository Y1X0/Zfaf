import { z } from 'zod';

import { ThemeSchema, type Theme } from '../../template/domain/theme.js';
import { SectionInstanceSchema } from '../../template/domain/section.js';
import { type PublishedSnapshot, createSnapshot } from './published-snapshot.js';

/**
 * The draft document — what the builder edits (D5.1).
 *
 * Deliberately *not* the published snapshot schema. A snapshot requires a
 * groom's name, a bride's name and a date, because those are what an
 * invitation guests can read must have. A draft is a work in progress: it
 * begins entirely empty and has to survive being saved, previewed and reloaded
 * in that state.
 *
 * Two consequences follow, and they are the whole reason this module exists:
 *
 *   • **Every field is optional or nullable here.** Validation for publishing
 *     is a separate question, answered by `publishReadiness`, and asked at
 *     publish time rather than on every keystroke.
 *   • **The preview needs a snapshot but the draft is not one.** So there is a
 *     projection, `toPreviewSnapshot`, which fills placeholders for the fields
 *     a couple has not reached yet. The placeholders exist only in preview —
 *     they can never be published, because publishing goes through
 *     `createSnapshot` on the real values.
 */

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const DraftMediaSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    width: z.number().int().positive().nullable().default(null),
    height: z.number().int().positive().nullable().default(null),
    blurhash: z.string().nullable().default(null),
    alt: z.string().max(300).nullable().default(null),
  })
  .strict();

const DraftEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['contract', 'reception', 'wedding', 'dinner', 'custom']),
    title: z.string().max(120),
    description: z.string().max(1000).nullable().default(null),
    date: DateSchema,
    startTime: TimeSchema.nullable().default(null),
    endTime: TimeSchema.nullable().default(null),
    timezone: z.string().min(1),
    venueName: z.string().max(200).nullable().default(null),
    venueAddress: z.string().max(500).nullable().default(null),
    mapsUrl: z.string().url().nullable().default(null),
    sortOrder: z.number().int(),
  })
  .strict();

export const DraftDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    templateKey: z.string().min(1),
    templateVersion: z.number().int().positive(),
    locale: z.enum(['ar', 'en']),
    timezone: z.string().min(1),
    theme: ThemeSchema,
    sections: z.array(SectionInstanceSchema).max(30),
    content: z
      .object({
        couple: z
          .object({
            // Empty is the starting state, not an error.
            groomName: z.string().max(80),
            brideName: z.string().max(80),
            shortName: z.string().max(40).nullable(),
            message: z.string().max(2000).nullable(),
            photo: DraftMediaSchema.nullable(),
          })
          .strict(),
        wedding: z
          .object({
            date: DateSchema.nullable(),
            startTime: TimeSchema.nullable(),
            endTime: TimeSchema.nullable(),
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
        events: z.array(DraftEventSchema).max(20),
        cover: DraftMediaSchema.nullable(),
        gallery: z.array(DraftMediaSchema).max(60),
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
            deadline: DateSchema.nullable(),
            maxPartySize: z.number().int().min(0).max(50),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type DraftDocument = z.infer<typeof DraftDocumentSchema>;

export function parseDraftDocument(
  input: unknown,
): { ok: true; document: DraftDocument } | { ok: false; errors: readonly string[] } {
  const parsed = DraftDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  return { ok: true, document: parsed.data };
}

/**
 * The document a brand-new invitation starts from.
 *
 * Built from the template's own manifest, so a couple who changes nothing
 * still has something publishable-looking in the preview from the first
 * second (docs/06 §1: "الافتراضيات جميلة").
 */
export function createDraftDocument(input: {
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly theme: Theme;
  readonly sections: DraftDocument['sections'];
  readonly locale: 'ar' | 'en';
  readonly timezone: string;
}): DraftDocument {
  return {
    schemaVersion: 1,
    templateKey: input.templateKey,
    templateVersion: input.templateVersion,
    locale: input.locale,
    timezone: input.timezone,
    theme: input.theme,
    sections: input.sections,
    content: {
      couple: { groomName: '', brideName: '', shortName: null, message: null, photo: null },
      wedding: { date: null, startTime: null, endTime: null, timezone: input.timezone },
      location: { venueName: null, address: null, latitude: null, longitude: null, mapsUrl: null },
      events: [],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      // On by default: a couple who never opens the RSVP step still gets
      // replies, which is the single most valuable thing the product does.
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
  };
}

// ── readiness ──────────────────────────────────────────────────────────────

export type ReadinessSeverity = 'required' | 'suggested';

export interface ReadinessIssue {
  readonly field: string;
  readonly severity: ReadinessSeverity;
  readonly step: BuilderStepId;
  readonly messageKey: string;
}

/**
 * What is missing, and whether it actually blocks publishing.
 *
 * The minimum is three fields — two names and a date (docs/06 §3). Everything
 * else is a *suggestion*, surfaced as a warning at publish time rather than a
 * gate. Refusing to publish an invitation because the venue is blank would be
 * us deciding a couple's invitation is wrong, and they may genuinely be
 * telling guests the location later.
 */
export function publishReadiness(document: DraftDocument): readonly ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  const { couple, wedding, location, gallery } = document.content;

  if (couple.groomName.trim().length === 0) {
    issues.push({
      field: 'content.couple.groomName',
      severity: 'required',
      step: 'couple',
      messageKey: 'builder.readiness.groomName',
    });
  }
  if (couple.brideName.trim().length === 0) {
    issues.push({
      field: 'content.couple.brideName',
      severity: 'required',
      step: 'couple',
      messageKey: 'builder.readiness.brideName',
    });
  }
  if (!wedding.date) {
    issues.push({
      field: 'content.wedding.date',
      severity: 'required',
      step: 'date',
      messageKey: 'builder.readiness.date',
    });
  }

  if (!location.venueName && !location.address) {
    issues.push({
      field: 'content.location.venueName',
      severity: 'suggested',
      step: 'location',
      messageKey: 'builder.readiness.venue',
    });
  }
  if (!wedding.startTime) {
    issues.push({
      field: 'content.wedding.startTime',
      severity: 'suggested',
      step: 'date',
      messageKey: 'builder.readiness.startTime',
    });
  }
  if (gallery.length === 0 && !document.content.cover) {
    issues.push({
      field: 'content.gallery',
      severity: 'suggested',
      step: 'photos',
      messageKey: 'builder.readiness.photos',
    });
  }

  return issues;
}

export function canPublish(document: DraftDocument): boolean {
  return publishReadiness(document).every((issue) => issue.severity !== 'required');
}

// ── steps ──────────────────────────────────────────────────────────────────

export const BUILDER_STEPS = ['couple', 'date', 'location', 'events', 'photos', 'music'] as const;

export type BuilderStepId = (typeof BUILDER_STEPS)[number];

export interface BuilderStep {
  readonly id: BuilderStepId;
  readonly labelKey: string;
  /** Whether the step must be completed before publishing. */
  readonly required: boolean;
}

export const BUILDER_STEP_DEFINITIONS: readonly BuilderStep[] = [
  { id: 'couple', labelKey: 'builder.step.couple', required: true },
  { id: 'date', labelKey: 'builder.step.date', required: true },
  { id: 'location', labelKey: 'builder.step.location', required: false },
  { id: 'events', labelKey: 'builder.step.events', required: false },
  { id: 'photos', labelKey: 'builder.step.photos', required: false },
  { id: 'music', labelKey: 'builder.step.music', required: false },
];

/**
 * Whether a step has enough in it to show a tick.
 *
 * Progressive rather than gating: a user may move between steps freely, in any
 * order. The tick is feedback, not permission — blocking step 3 until step 2
 * is perfect is how a builder becomes a form nobody finishes.
 */
export function isStepComplete(document: DraftDocument, step: BuilderStepId): boolean {
  const { couple, wedding, location, events, gallery, cover, music } = document.content;

  switch (step) {
    case 'couple':
      return couple.groomName.trim().length > 0 && couple.brideName.trim().length > 0;
    case 'date':
      return wedding.date !== null;
    case 'location':
      return Boolean(location.venueName || location.address);
    case 'events':
      return events.length > 0;
    case 'photos':
      return gallery.length > 0 || cover !== null || couple.photo !== null;
    case 'music':
      return music.trackId !== null;
  }
}

// ── preview projection ─────────────────────────────────────────────────────

/** Shown where a couple has not filled a required field yet. Preview only. */
export const PREVIEW_PLACEHOLDERS = {
  ar: { groomName: 'اسم العريس', brideName: 'اسم العروس' },
  en: { groomName: "Groom's name", brideName: "Bride's name" },
} as const;

/**
 * Projects a draft into something the renderer can draw.
 *
 * The renderer takes a `PublishedSnapshot` and only that — which is the point
 * of "what you see is what gets published". A half-filled draft is not a valid
 * snapshot, so this fills the gaps rather than teaching the renderer about
 * drafts, which would fork the two code paths and void the guarantee.
 *
 * `publishedAt` is passed in rather than read from a clock, so the projection
 * stays pure and the preview stays deterministic.
 */
export function toPreviewSnapshot(
  document: DraftDocument,
  previewedAt: string,
): { ok: true; snapshot: PublishedSnapshot } | { ok: false; errors: readonly string[] } {
  const placeholders = PREVIEW_PLACEHOLDERS[document.locale];
  const { content } = document;

  const result = createSnapshot({
    schemaVersion: 1,
    templateKey: document.templateKey,
    templateVersion: document.templateVersion,
    locale: document.locale,
    timezone: document.timezone,
    theme: document.theme,
    sections: document.sections,
    content: {
      couple: {
        groomName: content.couple.groomName.trim() || placeholders.groomName,
        brideName: content.couple.brideName.trim() || placeholders.brideName,
        shortName: content.couple.shortName,
        message: content.couple.message,
        photo: content.couple.photo,
      },
      wedding: {
        // A date the couple has not chosen yet still has to render as
        // *something*, or the countdown and the date line vanish and the
        // preview stops resembling the finished invitation.
        date: content.wedding.date ?? nextYear(previewedAt),
        startTime: content.wedding.startTime,
        endTime: content.wedding.endTime,
        timezone: content.wedding.timezone,
      },
      location: content.location,
      events: content.events.map((event) => ({
        ...event,
        title: event.title.trim() || (document.locale === 'ar' ? 'حدث' : 'Event'),
      })),
      cover: content.cover,
      gallery: content.gallery,
      music: content.music,
      rsvp: content.rsvp,
    },
    publishedAt: previewedAt,
  });

  if (!result.ok) {
    return { ok: false, errors: result.errors.map((error) => `${error.path}: ${error.message}`) };
  }
  return { ok: true, snapshot: result.snapshot };
}

/** A year out from the given instant, as `YYYY-MM-DD`. */
function nextYear(isoInstant: string): string {
  const parsed = new Date(isoInstant);
  const year = parsed.getUTCFullYear() + 1;
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
