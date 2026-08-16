import { describe, expect, it } from 'vitest';
import {
  type Theme,
  ThemeSchema,
  WCAG_AA_NORMAL_TEXT,
  adjustToContrast,
  checkThemeContrast,
  contrastRatio,
  readableForegroundOn,
} from '@zfaf/core';

import { TEMPLATE_KEYS, manifestFor } from '../testing/snapshot-fixture.js';
import { themeToCssVariables } from './to-css-variables.js';

/**
 * Readability of the controls a guest has to press (M9, found by Lighthouse).
 *
 * A published invitation whose owner had chosen `#b8860b` on ivory rendered its
 * share button, its RSVP submit and its map link in near-white on gold — a
 * measured 3.2:1 against a 4.5:1 requirement. Every shipped template cleared
 * the bar, so the defect only ever appeared through a customised palette, and
 * only on the elements that put ordinary-sized text on the primary colour.
 *
 * The palette below is that exact one, kept as the regression case: it is a
 * real published document, not an invented worst case.
 */
const FAILING = { primary: '#b8860b', background: '#fffdf8' } as const;

function variable(theme: Theme, name: string): string {
  const found = themeToCssVariables(theme).find(([key]) => key === name);
  if (!found) throw new Error(`${name} is not emitted`);
  return found[1];
}

/** A shipped template's theme, parsed the way the render path parses it. */
function themeOf(templateKey: string): Theme {
  return ThemeSchema.parse(manifestFor(templateKey)['theme']);
}

/** The published palette above, dropped into a real template's theme. */
function themeWith(colors: Partial<Theme['colors']>): Theme {
  const base = themeOf('classic-luxury');
  return { ...base, colors: { ...base.colors, ...colors } };
}

describe('text on the primary colour', () => {
  it('is legible on the palette that failed WCAG AA in production', () => {
    const theme = themeWith(FAILING);
    const onPrimary = variable(theme, '--zf-color-on-primary');

    const ratio = contrastRatio(onPrimary, FAILING.primary);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it.each(TEMPLATE_KEYS)('%s keeps the exact colour its designer chose', (templateKey) => {
    // The guarantee must be inert where it is not needed: a template that
    // already passes must render byte-identically to before this existed.
    const theme = themeOf(templateKey);
    expect(variable(theme, '--zf-color-on-primary')).toBe(theme.colors.background);
    expect(variable(theme, '--zf-color-primary-text')).toBe(theme.colors.primary);
  });

  it('is emitted for every theme, so the stylesheet never falls back silently', () => {
    for (const templateKey of TEMPLATE_KEYS) {
      const names = themeToCssVariables(themeOf(templateKey)).map(([name]) => name);
      expect(names).toContain('--zf-color-on-primary');
      expect(names).toContain('--zf-color-primary-text');
    }
  });
});

describe('the primary colour used as ordinary text', () => {
  it('is darkened until it clears AA on a light background', () => {
    const theme = themeWith(FAILING);
    const primaryText = variable(theme, '--zf-color-primary-text');

    expect(primaryText).not.toBe(FAILING.primary);
    const ratio = contrastRatio(primaryText, FAILING.background) as number;
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it('walks towards white on a dark background, not away from it', () => {
    // The direction is the whole function. The renderer-local copy this
    // replaced had it inverted, so it stepped further into the background on
    // every iteration and returned the one colour guaranteed to fail.
    const adjusted = adjustToContrast('#333333', '#0e0e0e');
    const ratio = contrastRatio(adjusted, '#0e0e0e') as number;
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it('leaves a colour that already passes exactly as it is', () => {
    expect(adjustToContrast('#241f1a', '#fffdf8')).toBe('#241f1a');
  });
});

describe('readableForegroundOn', () => {
  it('prefers the colour it was given when that colour is legible', () => {
    expect(readableForegroundOn('#111111', '#ffffff')).toBe('#ffffff');
  });

  it('falls back to black or white, whichever the background can carry', () => {
    expect(readableForegroundOn('#b8860b', '#fffdf8')).toBe('#000000');
    expect(readableForegroundOn('#0e0e0e', '#333333')).toBe('#ffffff');
  });

  it('never returns something below AA, for any hex colour', () => {
    // The worst case for this rule is a mid-tone, where black and white are
    // equally poor — and even there the better of the two measures ≈4.58:1.
    for (let value = 0; value < 256; value += 1) {
      const hex = `#${value.toString(16).padStart(2, '0').repeat(3)}`;
      const foreground = readableForegroundOn(hex, '#ffffff');
      expect(contrastRatio(foreground, hex) as number).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    }
  });
});

describe('the contrast warning surfaced in the builder', () => {
  it('names the pair that was missing until M9', () => {
    const warnings = checkThemeContrast(themeWith(FAILING));
    expect(warnings.map((warning) => warning.pair)).toContain('background/primary');
  });

  it.each(TEMPLATE_KEYS)('%s still carries no warning at all', (templateKey) => {
    expect(checkThemeContrast(themeOf(templateKey))).toEqual([]);
  });
});
