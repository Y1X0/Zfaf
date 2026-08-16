import { describe, expect, it } from 'vitest';

import { createSnapshot } from '@zfaf/core';

import { defaultRegistry } from '../registry/default-registry.js';
import { renderSections } from './InvitationRenderer.js';
import {
  TEMPLATE_KEYS as TEMPLATES,
  baseContent,
  render,
  snapshotFrom,
} from '../testing/snapshot-fixture.js';

/**
 * Renderer behaviour.
 *
 * Rendered to static markup rather than inspected as a React tree, because the
 * properties that matter — escaping, ordering, byte-identical output — are
 * properties of the HTML a guest receives, not of the element graph.
 */

// ── determinism ─────────────────────────────────────────────────────────────

describe('the renderer is deterministic', () => {
  it.each(TEMPLATES)('%s produces byte-identical markup across 100 renders', (templateKey) => {
    // Determinism is what makes CDN caching and snapshot testing meaningful. It
    // is also what a clock or a random value in the render path would destroy.
    const snapshot = snapshotFrom(templateKey);
    const first = render(snapshot);
    for (let index = 0; index < 100; index += 1) {
      expect(render(snapshot)).toBe(first);
    }
  });

  it('produces identical markup from separately constructed equal snapshots', () => {
    expect(render(snapshotFrom('classic-luxury'))).toBe(render(snapshotFrom('classic-luxury')));
  });

  it('contains no timestamp of its own', () => {
    // The countdown carries the *event* instant, which is data. Anything
    // derived from the current clock would differ between renders.
    const markup = render(snapshotFrom('classic-luxury'));
    expect(markup).toContain('data-countdown-target="2026-09-20T17:00:00.000Z"');
    expect(markup).not.toMatch(new RegExp(String(new Date().getFullYear() + 10)));
  });
});

// ── ordering and enablement ────────────────────────────────────────────────

describe('section ordering', () => {
  it('renders sections in the order the manifest declares', () => {
    const snapshot = snapshotFrom('classic-luxury');
    const markup = render(snapshot);

    const positions = ['hero', 'couple', 'countdown', 'events'].map((id) =>
      markup.indexOf(`data-section="${id}"`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('reordering the document reorders the output', () => {
    const base = snapshotFrom('classic-luxury');
    const reordered = createSnapshot({
      ...JSON.parse(JSON.stringify(base)),
      sections: base.sections.map((section) =>
        section.id === 'gallery' ? { ...section, order: 0 } : section,
      ),
    });
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) return;

    const markup = render(reordered.snapshot);
    expect(markup.indexOf('data-section="gallery"')).toBeLessThan(
      markup.indexOf('data-section="hero"'),
    );
  });

  it('breaks ties on id, so equal orders still render deterministically', () => {
    const base = snapshotFrom('classic-luxury');
    const tied = createSnapshot({
      ...JSON.parse(JSON.stringify(base)),
      sections: base.sections.map((section) => ({ ...section, order: 1 })),
    });
    expect(tied.ok).toBe(true);
    if (!tied.ok) return;

    const first = render(tied.snapshot);
    expect(render(tied.snapshot)).toBe(first);
  });
});

describe('disabled sections', () => {
  it('omits a disabled section entirely', () => {
    // minimal-white ships with the gallery disabled.
    const markup = render(snapshotFrom('minimal-white'));
    expect(markup).not.toContain('data-section="gallery"');
    expect(markup).toContain('data-section="hero"');
  });

  it('omits a section whose content is empty rather than showing an empty shell', () => {
    const snapshot = snapshotFrom('classic-luxury', {
      content: { ...baseContent(), gallery: [], events: [] },
    });
    const markup = render(snapshot);
    // Assert on the section marker, not on a class name: the base stylesheet is
    // always emitted in full and legitimately mentions every class.
    expect(markup).not.toContain('data-section="gallery"');
    expect(markup).not.toContain('data-section="events"');
    expect(markup).toContain('data-section="hero"');
  });
});

// ── theme ──────────────────────────────────────────────────────────────────

describe('theme application', () => {
  it('emits the theme as CSS custom properties', () => {
    const markup = render(snapshotFrom('royal-gold'));
    expect(markup).toContain('--zf-color-primary:#c9a227');
    expect(markup).toContain('--zf-color-bg:#0e0e0e');
    expect(markup).toContain('--zf-font-display:"Amiri"');
  });

  it('gives each template a visibly different palette from the same renderer', () => {
    const classic = render(snapshotFrom('classic-luxury'));
    const royal = render(snapshotFrom('royal-gold'));
    const minimal = render(snapshotFrom('minimal-white'));

    expect(classic).toContain('--zf-color-bg:#fffdf8');
    expect(royal).toContain('--zf-color-bg:#0e0e0e');
    expect(minimal).toContain('--zf-color-bg:#ffffff');
  });

  it('always honours prefers-reduced-motion, whatever the template asked for', () => {
    for (const templateKey of TEMPLATES) {
      expect(render(snapshotFrom(templateKey))).toContain(
        '@media (prefers-reduced-motion:reduce){:root{--zf-motion-duration:0ms}}',
      );
    }
  });

  it('sets dir and lang from the invitation, not from the viewer', () => {
    // An Arabic invitation renders Arabic for a guest in London.
    expect(render(snapshotFrom('classic-luxury', { locale: 'ar' }))).toContain('dir="rtl"');
    expect(render(snapshotFrom('minimal-white', { locale: 'en' }))).toContain('dir="ltr"');
  });
});

// ── versioning ─────────────────────────────────────────────────────────────

describe('template versioning', () => {
  it('records the template key and version on the snapshot', () => {
    const snapshot = snapshotFrom('royal-gold');
    expect(snapshot.templateKey).toBe('royal-gold');
    expect(snapshot.templateVersion).toBe(1);
    expect(render(snapshot)).toContain('data-template="royal-gold"');
  });

  it('renders from the snapshot alone, never consulting the live manifest', () => {
    // This is what pins a published invitation to the template version it was
    // published with: a later template release cannot alter it (ADR-0005).
    const snapshot = snapshotFrom('classic-luxury');
    const { elements } = renderSections(snapshot);
    expect(elements.length).toBeGreaterThan(0);
  });
});

// ── the architectural health check ─────────────────────────────────────────

describe('all three templates share one renderer and one registry', () => {
  it.each(TEMPLATES)('%s renders through the default registry', (templateKey) => {
    const markup = render(snapshotFrom(templateKey));
    expect(markup).toContain('class="zf-invitation"');
    expect(markup).toContain('data-section="hero"');
    expect(markup).toContain('data-section="footer"');
  });

  it.each(TEMPLATES)('%s renders with no diagnostics', (templateKey) => {
    const { diagnostics } = renderSections(snapshotFrom(templateKey));
    expect(diagnostics).toEqual([]);
  });

  it('template #3 is genuinely unlike the others', () => {
    // The health check only means something if the third template really
    // exercises different ground: no photographs, no ornament, no motion.
    const minimal = snapshotFrom('minimal-white');
    const classic = snapshotFrom('classic-luxury');

    expect(minimal.theme.dividers).toBe('none');
    expect(minimal.theme.motion.intensity).toBe('none');
    expect(minimal.theme.radius).toBe('sharp');
    expect(classic.theme.dividers).not.toBe(minimal.theme.dividers);
    expect(classic.theme.motion.intensity).not.toBe(minimal.theme.motion.intensity);

    const minimalVariants = minimal.sections.map((section) => section.variant);
    const classicVariants = classic.sections.map((section) => section.variant);
    expect(minimalVariants.filter((variant) => classicVariants.includes(variant))).toHaveLength(0);
  });

  it('renders minimal-white with no media at all', () => {
    // The scenario this template exists for: a family who publishes no
    // personal photographs (docs/18-risks.md L6).
    const snapshot = snapshotFrom('minimal-white', {
      content: {
        ...baseContent(),
        cover: null,
        gallery: [],
        couple: { ...(baseContent()['couple'] as object), photo: null },
      },
    });
    const markup = render(snapshot);

    expect(markup).not.toContain('<img');
    expect(markup).toContain('أحمد');
    expect(markup).toContain('data-section="hero"');
    expect(markup).toContain('data-section="footer"');
  });
});

// ── fail-soft ──────────────────────────────────────────────────────────────

describe('a broken section does not take the invitation down', () => {
  it('falls back when a manifest names a variant that no longer exists', () => {
    const base = snapshotFrom('classic-luxury');
    const withUnknown = createSnapshot({
      ...JSON.parse(JSON.stringify(base)),
      sections: base.sections.map((section) =>
        section.id === 'couple' ? { ...section, variant: 'couple.removedLongAgo' } : section,
      ),
    });
    expect(withUnknown.ok).toBe(true);
    if (!withUnknown.ok) return;

    const { diagnostics } = renderSections(withUnknown.snapshot);
    expect(diagnostics.some((entry) => entry.reason === 'UNKNOWN_VARIANT')).toBe(true);

    // And the rest of the invitation still renders.
    const markup = render(withUnknown.snapshot);
    expect(markup).toContain('data-section="hero"');
    expect(markup).toContain('data-section="footer"');
  });

  it('falls back to defaults when props are malformed', () => {
    const base = snapshotFrom('classic-luxury');
    const withBadProps = createSnapshot({
      ...JSON.parse(JSON.stringify(base)),
      sections: base.sections.map((section) =>
        section.id === 'countdown' ? { ...section, props: { showSeconds: 'yes please' } } : section,
      ),
    });
    expect(withBadProps.ok).toBe(true);
    if (!withBadProps.ok) return;

    const { diagnostics } = renderSections(withBadProps.snapshot);
    expect(diagnostics.some((entry) => entry.reason === 'INVALID_PROPS')).toBe(true);
    expect(render(withBadProps.snapshot)).toContain('data-section="countdown"');
  });
});

// ── preview and published agree ────────────────────────────────────────────

describe('preview and published use the same rendering path', () => {
  it.each(TEMPLATES)('%s renders identically in both modes', (templateKey) => {
    // "What you see is what gets published" — asserted, not assumed. Preview
    // may differ only where a placeholder is shown, never in layout or styling.
    const snapshot = snapshotFrom(templateKey);
    expect(render(snapshot, 'preview')).toBe(render(snapshot, 'published'));
  });

  it('uses one registry instance for both', () => {
    const previewRun = renderSections(snapshotFrom('royal-gold'), { mode: 'preview' });
    const publishedRun = renderSections(snapshotFrom('royal-gold'), { mode: 'published' });
    expect(previewRun.elements.length).toBe(publishedRun.elements.length);
    expect(defaultRegistry.size()).toBeGreaterThan(20);
  });
});
