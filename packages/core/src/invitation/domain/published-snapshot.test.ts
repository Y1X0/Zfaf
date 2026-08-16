import { describe, expect, it } from 'vitest';

import { createSnapshot, readSnapshot } from './published-snapshot.js';

/**
 * Snapshot immutability is a domain invariant, not a UI convention (ADR-0005).
 * These tests cover the two in-process layers; the database trigger — the layer
 * that actually holds against raw SQL — is covered by the integration suite.
 */

function validSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    templateKey: 'classic-luxury',
    templateVersion: 1,
    locale: 'ar',
    timezone: 'Asia/Riyadh',
    theme: {
      colors: {
        primary: '#b8860b',
        secondary: '#1b1b1b',
        accent: '#e8d9a0',
        background: '#fffdf8',
        surface: '#ffffff',
        textPrimary: '#1a1a1a',
        textSecondary: '#4a4a4a',
        overlay: 'rgba(0, 0, 0, 0.5)',
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
      motion: { intensity: 'subtle', effects: [] },
      numerals: 'latin',
    },
    sections: [
      { id: 's1', type: 'hero', variant: 'hero.centeredArch', enabled: true, order: 1, props: {} },
      { id: 's2', type: 'footer', variant: 'footer.ornament', enabled: true, order: 2, props: {} },
    ],
    content: {
      couple: {
        groomName: 'أحمد',
        brideName: 'سارة',
        shortName: null,
        message: 'بكل الحب ندعوكم',
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
      events: [],
      cover: null,
      gallery: [],
      music: { trackId: null, url: null, title: null, attribution: null },
      rsvp: { enabled: true, deadline: null, maxPartySize: 5 },
    },
    publishedAt: '2026-08-16T10:00:00.000Z',
  };
}

describe('createSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const result = createSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
  });

  it('deep-freezes the result, including nested objects and arrays', () => {
    const result = createSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.theme)).toBe(true);
    expect(Object.isFrozen(result.snapshot.theme.colors)).toBe(true);
    expect(Object.isFrozen(result.snapshot.sections)).toBe(true);
    expect(Object.isFrozen(result.snapshot.sections[0])).toBe(true);
    expect(Object.isFrozen(result.snapshot.content.couple)).toBe(true);
  });

  it('silently ignores mutation attempts in sloppy mode, and throws in strict mode', () => {
    const result = createSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Test files are ES modules, so assignment to a frozen object throws.
    expect(() => {
      (result.snapshot.content.couple as { groomName: string }).groomName = 'someone else';
    }).toThrow();

    expect(() => {
      (result.snapshot.sections as unknown as unknown[]).push({});
    }).toThrow();

    expect(result.snapshot.content.couple.groomName).toBe('أحمد');
    expect(result.snapshot.sections).toHaveLength(2);
  });

  it('rejects a snapshot missing required content', () => {
    const invalid = validSnapshot();
    delete (invalid['content'] as Record<string, unknown>)['couple'];
    const result = createSnapshot(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.path.includes('couple'))).toBe(true);
  });

  it('rejects unknown top-level keys rather than carrying them through', () => {
    const result = createSnapshot({ ...validSnapshot(), injectedField: 'surprise' });
    expect(result.ok).toBe(false);
  });

  it('rejects a theme colour that is not a safe colour value', () => {
    const invalid = validSnapshot();
    // A value like this would escape its CSS declaration if injected verbatim.
    (invalid['theme'] as Record<string, Record<string, string>>)['colors']!['primary'] =
      'red; } body { display: none } .x {';
    const result = createSnapshot(invalid);
    expect(result.ok).toBe(false);
  });

  it('rejects a variant that does not belong to its section type', () => {
    const invalid = validSnapshot();
    (invalid['sections'] as Array<Record<string, unknown>>)[0]!['variant'] = 'gallery.masonry';
    const result = createSnapshot(invalid);
    expect(result.ok).toBe(false);
  });

  it('rejects more sections than the document limit allows', () => {
    const invalid = validSnapshot();
    invalid['sections'] = Array.from({ length: 31 }, (_, index) => ({
      id: `s${index}`,
      type: 'hero',
      variant: 'hero.centeredArch',
      enabled: true,
      order: index,
      props: {},
    }));
    expect(createSnapshot(invalid).ok).toBe(false);
  });

  it('rejects a party size beyond the domain limit', () => {
    const invalid = validSnapshot();
    (
      (invalid['content'] as Record<string, Record<string, unknown>>)['rsvp'] as Record<
        string,
        unknown
      >
    )['maxPartySize'] = 500;
    expect(createSnapshot(invalid).ok).toBe(false);
  });
});

describe('readSnapshot', () => {
  it('re-validates stored data rather than trusting the row', () => {
    // A snapshot written by an older schema, or altered outside the
    // application, must not render.
    expect(readSnapshot({ schemaVersion: 1 }).ok).toBe(false);
    expect(readSnapshot(null).ok).toBe(false);
    expect(readSnapshot('not an object').ok).toBe(false);
  });

  it('round-trips a valid snapshot', () => {
    const created = createSnapshot(validSnapshot());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const reread = readSnapshot(JSON.parse(JSON.stringify(created.snapshot)));
    expect(reread.ok).toBe(true);
    if (reread.ok) {
      expect(reread.snapshot.content.couple.groomName).toBe('أحمد');
      expect(Object.isFrozen(reread.snapshot)).toBe(true);
    }
  });
});

describe('the domain exposes no way to modify a published snapshot', () => {
  it('has no update function in the module surface', async () => {
    const module = await import('./published-snapshot.js');
    const mutators = Object.keys(module).filter((name) => /update|mutate|set|patch/i.test(name));
    expect(mutators).toEqual([]);
  });
});
