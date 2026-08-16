import type { DraftDocument, PatchOperation } from '@zfaf/core';

/**
 * The edits the builder can make, as named operations.
 *
 * Every form control produces a patch through one of these rather than
 * building a pointer inline. Two reasons, and the second is the important one:
 *
 *   • A typo in a hand-written pointer fails at the server as
 *     `PATH_NOT_ALLOWED` — a confusing error for something that is really a
 *     client bug.
 *   • The set of paths the builder writes is now enumerable in one file, which
 *     is what makes it reviewable against the server's allowlist. Two lists
 *     that must agree should be readable side by side.
 */

export type EditFactory = (value: never) => readonly PatchOperation[];

const replace = (path: string, value: unknown): PatchOperation => ({ op: 'replace', path, value });

/** An optional text field: empty means null, not an empty string. */
function optionalText(path: string, value: string): PatchOperation {
  const trimmed = value.trim();
  return replace(path, trimmed.length > 0 ? trimmed : null);
}

export const edits = {
  groomName: (value: string) => [replace('/content/couple/groomName', value)],
  brideName: (value: string) => [replace('/content/couple/brideName', value)],
  shortName: (value: string) => [optionalText('/content/couple/shortName', value)],
  coupleMessage: (value: string) => [optionalText('/content/couple/message', value)],

  weddingDate: (value: string) => [replace('/content/wedding/date', value || null)],
  weddingStartTime: (value: string) => [replace('/content/wedding/startTime', value || null)],
  weddingEndTime: (value: string) => [replace('/content/wedding/endTime', value || null)],
  /**
   * Changing the zone rewrites both copies.
   *
   * The document carries a time zone at the top *and* inside `wedding`,
   * because the renderer reads the second and the invitation's own zone is the
   * first. Letting them drift is how a countdown ends up an hour out.
   */
  timezone: (value: string) => [
    replace('/timezone', value),
    replace('/content/wedding/timezone', value),
  ],

  venueName: (value: string) => [optionalText('/content/location/venueName', value)],
  venueAddress: (value: string) => [optionalText('/content/location/address', value)],
  mapsUrl: (value: string) => [replace('/content/location/mapsUrl', value.trim() || null)],
  coordinates: (value: { latitude: number | null; longitude: number | null }) => [
    replace('/content/location/latitude', value.latitude),
    replace('/content/location/longitude', value.longitude),
  ],

  addEvent: (value: DraftDocument['content']['events'][number]) => [
    { op: 'add' as const, path: '/content/events/-', value },
  ],
  removeEvent: (value: number) => [{ op: 'remove' as const, path: `/content/events/${value}` }],
  eventField: (value: { index: number; field: string; next: unknown }) => [
    replace(`/content/events/${value.index}/${value.field}`, value.next),
  ],

  removeGalleryImage: (value: number) => [
    { op: 'remove' as const, path: `/content/gallery/${value}` },
  ],
  setCover: (value: DraftDocument['content']['cover']) => [replace('/content/cover', value)],
  setCouplePhoto: (value: DraftDocument['content']['couple']['photo']) => [
    replace('/content/couple/photo', value),
  ],

  music: (value: DraftDocument['content']['music']) => [replace('/content/music', value)],

  rsvpEnabled: (value: boolean) => [replace('/content/rsvp/enabled', value)],
  rsvpMaxPartySize: (value: number) => [replace('/content/rsvp/maxPartySize', value)],

  themeColor: (value: { key: string; color: string }) => [
    replace(`/theme/colors/${value.key}`, value.color),
  ],
  themePalette: (value: Record<string, string>) =>
    Object.entries(value).map(([key, color]) => replace(`/theme/colors/${key}`, color)),
  themeFont: (value: { key: 'displayFont' | 'bodyFont'; font: string }) => [
    replace(`/theme/typography/${value.key}`, value.font),
  ],
  themeMotion: (value: string) => [replace('/theme/motion/intensity', value)],
  themeSpacing: (value: string) => [replace('/theme/spacing', value)],
  themeRadius: (value: string) => [replace('/theme/radius', value)],

  sectionEnabled: (value: { index: number; enabled: boolean }) => [
    replace(`/sections/${value.index}/enabled`, value.enabled),
  ],
  /**
   * Reordering rewrites the `order` of both sections rather than moving array
   * elements.
   *
   * `move` is not an operation the allowlist accepts, and swapping two indexes
   * with add/remove would renumber everything after them. Rewriting two
   * integers says exactly what changed.
   */
  swapSectionOrder: (value: {
    a: { index: number; order: number };
    b: { index: number; order: number };
  }) => [
    replace(`/sections/${value.a.index}/order`, value.b.order),
    replace(`/sections/${value.b.index}/order`, value.a.order),
  ],
} as const;
