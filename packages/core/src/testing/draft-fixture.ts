import { type DraftDocument, parseDraftDocument } from '../invitation/domain/draft-document.js';

/**
 * A publishable draft, shared by the tests that need one.
 *
 * Two properties make it worth having in one place rather than pasted into
 * each suite:
 *
 *   • It is built through `parseDraftDocument`, so it is subject to the same
 *     schema a document arriving over the wire is. A fixture that merely
 *     typechecks proves nothing — types are erased before the document reaches
 *     the database.
 *   • It is *complete*. Tests that need an unpublishable draft take this one
 *     and remove something, which makes each such test say exactly which
 *     single field it is about.
 */

/**
 * UTC, not a market's zone.
 *
 * A literal like `Asia/Riyadh` here would be a hard-coded market assumption
 * (ADR-0015) — and for a fixture it buys nothing: the zone under test is
 * whatever the test passes in, and a fixed offset makes the assertions
 * readable.
 */
const TEST_TIMEZONE = 'UTC';

export interface DraftFixtureOverrides {
  readonly groomName?: string;
  readonly brideName?: string;
  readonly date?: string | null;
  readonly locale?: 'ar' | 'en';
}

const THEME = {
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
} as const;

/** The raw object, as it would be stored in JSONB. */
export function validDraftInput(overrides: DraftFixtureOverrides = {}): unknown {
  return {
    schemaVersion: 1,
    templateKey: 'classic-luxury',
    templateVersion: 1,
    locale: overrides.locale ?? 'ar',
    timezone: TEST_TIMEZONE,
    theme: THEME,
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
        id: 'countdown',
        type: 'countdown',
        variant: 'countdown.ornateBoxes',
        enabled: true,
        order: 2,
        props: {},
      },
      {
        id: 'gallery',
        type: 'gallery',
        variant: 'gallery.grid',
        enabled: false,
        order: 3,
        props: {},
      },
      {
        id: 'footer',
        type: 'footer',
        variant: 'footer.simple',
        enabled: true,
        order: 4,
        props: {},
      },
    ],
    content: {
      couple: {
        groomName: overrides.groomName ?? 'أحمد',
        brideName: overrides.brideName ?? 'سارة',
        shortName: null,
        message: null,
        photo: null,
      },
      wedding: {
        date: overrides.date === undefined ? '2026-09-20' : overrides.date,
        startTime: '20:00',
        endTime: null,
        timezone: TEST_TIMEZONE,
      },
      location: {
        venueName: 'قاعة النخيل',
        address: null,
        latitude: null,
        longitude: null,
        mapsUrl: null,
      },
      events: [],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
  };
}

/** The same fixture, parsed. Throws loudly if it stops fitting the schema. */
export function validDraft(overrides: DraftFixtureOverrides = {}): DraftDocument {
  const parsed = parseDraftDocument(validDraftInput(overrides));
  if (!parsed.ok) {
    throw new Error(`The shared draft fixture no longer parses: ${parsed.errors.join(', ')}`);
  }
  return parsed.document;
}
