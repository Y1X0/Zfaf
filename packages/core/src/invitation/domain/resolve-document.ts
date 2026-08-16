import { type DraftDocument, publishReadiness } from './draft-document.js';
import { type PublishedSnapshot, createSnapshot } from './published-snapshot.js';

/**
 * Draft → published snapshot (ADR-0005, D6.2).
 *
 * The counterpart of `toPreviewSnapshot`, and deliberately *not* the same
 * function. The preview projection invents what a couple has not filled in yet
 * — a placeholder name, a date a year out — so that a half-built invitation
 * still looks like an invitation. Publishing must never do that: a guest
 * opening a link and reading "اسم العريس" is worse than the owner being told
 * to finish the form.
 *
 * So the two projections differ in exactly one way, and it is the way that
 * matters: this one **fails** where the preview substitutes.
 *
 * It is also the moment the snapshot becomes self-contained. Everything the
 * public page needs is copied in — the resolved media URLs, the pinned
 * template version, the invitation's own time zone — so that rendering it
 * later touches no other table, and neither a template release nor a deleted
 * media row can change what guests already received.
 */

export type ResolveIssue = {
  readonly field: string;
  readonly messageKey: string;
};

export type ResolveOutcome =
  | { readonly ok: true; readonly snapshot: PublishedSnapshot }
  | { readonly ok: false; readonly issues: readonly ResolveIssue[] };

export interface ResolveOptions {
  /**
   * The publish instant, as an ISO-8601 string.
   *
   * Passed in rather than read from a clock so the projection stays pure and
   * republishing the same draft at the same instant produces byte-identical
   * output — which is what makes the checksum meaningful.
   */
  readonly publishedAt: string;
}

export function resolveDocument(draft: DraftDocument, options: ResolveOptions): ResolveOutcome {
  // The same readiness rules the builder shows the owner while editing. Asking
  // twice with two different rule sets is how a UI ends up saying "ready to
  // publish" next to a button that refuses.
  const missing = publishReadiness(draft)
    .filter((issue) => issue.severity === 'required')
    .map((issue) => ({ field: issue.field, messageKey: issue.messageKey }));

  if (missing.length > 0) return { ok: false, issues: missing };

  const { content } = draft;

  const result = createSnapshot({
    schemaVersion: 1,
    templateKey: draft.templateKey,
    templateVersion: draft.templateVersion,
    locale: draft.locale,
    timezone: draft.timezone,
    theme: draft.theme,
    // Only the sections that will actually be drawn. Carrying disabled ones
    // into an immutable record would publish choices the owner turned off.
    sections: draft.sections.filter((section) => section.enabled),
    content: {
      couple: {
        groomName: content.couple.groomName.trim(),
        brideName: content.couple.brideName.trim(),
        shortName: emptyToNull(content.couple.shortName),
        message: emptyToNull(content.couple.message),
        photo: content.couple.photo,
      },
      wedding: {
        // Non-null by the readiness check above; the assertion is the schema's
        // job, and `createSnapshot` will reject it if that ever stops holding.
        date: content.wedding.date,
        startTime: content.wedding.startTime,
        endTime: content.wedding.endTime,
        timezone: content.wedding.timezone,
      },
      location: content.location,
      events: [...content.events]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((event) => ({ ...event, title: event.title.trim() }))
        // An untitled event is an unfinished one; it is dropped rather than
        // published as a blank row.
        .filter((event) => event.title.length > 0),
      cover: content.cover,
      gallery: content.gallery,
      music: content.music,
      rsvp: content.rsvp,
    },
    publishedAt: options.publishedAt,
  });

  if (!result.ok) {
    return {
      ok: false,
      issues: result.errors.map((error) => ({
        field: error.path,
        messageKey: 'publish.invalid',
      })),
    };
  }

  return { ok: true, snapshot: result.snapshot };
}

/** A field the owner cleared should be absent, not an empty string. */
function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
