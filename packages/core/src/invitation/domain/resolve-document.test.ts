import { describe, expect, it } from 'vitest';

import { type DraftDocument, parseDraftDocument, toPreviewSnapshot } from './draft-document.js';
import { resolveDocument } from './resolve-document.js';

/**
 * A draft with everything publishing requires, and nothing it does not.
 *
 * Built through `parseDraftDocument` rather than cast, so the fixture is
 * subject to the same schema the application is — a fixture that only
 * typechecks proves nothing about a document that arrived over the wire.
 */
function draft(overrides: (document: DraftDocument) => void = () => {}): DraftDocument {
  const parsed = parseDraftDocument({
    schemaVersion: 1,
    templateKey: 'classic',
    templateVersion: 2,
    locale: 'ar',
    timezone: 'Asia/Riyadh',
    theme: {
      colors: {
        primary: '#8a6d24',
        secondary: '#2f2a24',
        accent: '#d9c89a',
        background: '#fffdf8',
        surface: '#f7f2e7',
        textPrimary: '#241f1a',
        textSecondary: '#5c5348',
        overlay: 'rgba(36, 31, 26, 0.35)',
      },
      typography: {
        displayFont: 'aref-ruqaa',
        bodyFont: 'ibm-plex-arabic',
        scale: 'normal',
        displayWeight: 400,
      },
      spacing: 'normal',
      radius: 'soft',
      buttons: 'solid',
      dividers: 'ornament',
      background: { kind: 'solid', value: 'ivory', overlayOpacity: 0 },
      motion: { intensity: 'subtle', effects: ['float'] },
      numerals: 'latin',
    },
    sections: [
      {
        id: 'hero',
        type: 'hero',
        variant: 'hero.centeredArch',
        enabled: true,
        order: 1,
        props: {},
      },
      {
        id: 'gallery',
        type: 'gallery',
        variant: 'gallery.grid',
        enabled: false,
        order: 2,
        props: {},
      },
    ],
    content: {
      couple: {
        groomName: '  أحمد  ',
        brideName: 'سارة',
        shortName: '   ',
        message: null,
        photo: null,
      },
      wedding: {
        date: '2026-09-20',
        startTime: '20:00',
        endTime: null,
        timezone: 'Asia/Riyadh',
      },
      location: {
        venueName: 'قاعة النخيل',
        address: null,
        latitude: null,
        longitude: null,
        mapsUrl: null,
      },
      events: [
        {
          id: 'e2',
          type: 'reception',
          title: 'الاستقبال',
          description: null,
          date: '2026-09-20',
          startTime: '20:00',
          endTime: null,
          timezone: 'Asia/Riyadh',
          venueName: null,
          venueAddress: null,
          mapsUrl: null,
          sortOrder: 2,
        },
        {
          id: 'e1',
          type: 'contract',
          title: 'عقد القران',
          description: null,
          date: '2026-09-19',
          startTime: null,
          endTime: null,
          timezone: 'Asia/Riyadh',
          venueName: null,
          venueAddress: null,
          mapsUrl: null,
          sortOrder: 1,
        },
      ],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
  });

  if (!parsed.ok) throw new Error(`fixture is not a valid draft: ${parsed.errors.join(', ')}`);
  const document = structuredClone(parsed.document);
  overrides(document);
  return document;
}

const publishedAt = '2026-08-16T10:00:00.000Z';

describe('resolveDocument', () => {
  it('projects a complete draft', () => {
    const result = resolveDocument(draft(), { publishedAt });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.content.couple.groomName).toBe('أحمد');
    expect(result.snapshot.templateVersion).toBe(2);
    expect(result.snapshot.publishedAt).toBe(publishedAt);
  });

  it('refuses where the preview would invent a placeholder', () => {
    // This is the whole difference between the two projections. A guest opening
    // a link and reading "اسم العريس" is worse than the owner being told to
    // finish the form.
    const empty = draft((document) => {
      document.content.couple.groomName = '';
    });

    const preview = toPreviewSnapshot(empty, publishedAt);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.snapshot.content.couple.groomName).toBe('اسم العريس');

    const published = resolveDocument(empty, { publishedAt });
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.issues.map((issue) => issue.field)).toContain('content.couple.groomName');
  });

  it('refuses a draft with no date rather than inventing one a year out', () => {
    const undated = draft((document) => {
      document.content.wedding.date = null;
    });
    const result = resolveDocument(undated, { publishedAt });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((issue) => issue.field)).toContain('content.wedding.date');
  });

  it('drops sections the owner turned off', () => {
    // Carrying a disabled section into an immutable record would publish a
    // choice the owner made against.
    const result = resolveDocument(draft(), { publishedAt });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.sections.map((section) => section.id)).toEqual(['hero']);
  });

  it('orders events by the owner’s ordering, not the array’s', () => {
    const result = resolveDocument(draft(), { publishedAt });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.content.events.map((event) => event.id)).toEqual(['e1', 'e2']);
  });

  it('drops an event the owner added but never titled', () => {
    const withBlank = draft((document) => {
      document.content.events.push({
        ...(document.content.events[0] as (typeof document.content.events)[number]),
        id: 'blank',
        title: '   ',
        sortOrder: 9,
      });
    });
    const result = resolveDocument(withBlank, { publishedAt });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.content.events.map((event) => event.id)).not.toContain('blank');
  });

  it('turns a field the owner cleared into an absent one', () => {
    const result = resolveDocument(draft(), { publishedAt });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.content.couple.shortName).toBeNull();
  });

  it('is deterministic for the same draft and instant', () => {
    // What makes the checksum, and therefore tamper detection, meaningful.
    const first = resolveDocument(draft(), { publishedAt });
    const second = resolveDocument(draft(), { publishedAt });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(second.snapshot));
  });
});
