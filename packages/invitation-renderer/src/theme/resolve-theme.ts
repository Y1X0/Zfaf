import {
  type ContrastWarning,
  type Theme,
  type ThemeOverrides,
  ThemeSchema,
  checkThemeContrast,
  contrastRatio,
  WCAG_AA_NORMAL_TEXT,
} from '@zfaf/core';

/**
 * Theme resolution.
 *
 * A theme is data all the way down: every value is drawn from a closed set or
 * matched against a strict pattern before it can reach a stylesheet. There is
 * no path by which a user or a manifest supplies CSS.
 *
 * Resolution is: template default ⊕ user overrides → accessibility guard →
 * validated theme. The guard runs last so it cannot be bypassed by ordering.
 */

export interface ResolvedTheme {
  readonly theme: Theme;
  /** Colour pairs that fall below WCAG AA, reported for the builder to surface. */
  readonly warnings: readonly ContrastWarning[];
  /** True when the guard changed a colour the user chose. */
  readonly adjusted: boolean;
}

/**
 * Merges overrides onto a base theme.
 *
 * Overrides are stored partially on purpose: a user who only changed the
 * primary colour keeps receiving every later improvement to the template's
 * palette. A full copy would freeze them at the version they first edited.
 */
function mergeTheme(base: Theme, overrides: ThemeOverrides | undefined): unknown {
  if (!overrides) return base;

  return {
    ...base,
    colors: { ...base.colors, ...(overrides.colors ?? {}) },
    typography: { ...base.typography, ...(overrides.typography ?? {}) },
    spacing: overrides.spacing ?? base.spacing,
    radius: overrides.radius ?? base.radius,
    buttons: overrides.buttons ?? base.buttons,
    dividers: overrides.dividers ?? base.dividers,
    background: { ...base.background, ...(overrides.background ?? {}) },
    motion: {
      ...base.motion,
      ...(overrides.motion ?? {}),
      effects: overrides.motion?.effects ?? base.motion.effects,
    },
    numerals: overrides.numerals ?? base.numerals,
  };
}

/**
 * Darkens or lightens a hex colour until it clears a contrast ratio.
 *
 * Adjusts rather than rejects. Refusing a bride's chosen palette outright is
 * worse product behaviour than telling her it will be hard to read and offering
 * the nearest colour that works (docs/05-template-engine.md §6).
 */
function adjustForContrast(foreground: string, background: string, required: number): string {
  const parsed = /^#([0-9a-fA-F]{6})$/.exec(foreground);
  if (!parsed) return foreground;

  const backgroundLuminance = contrastRatio('#ffffff', background);
  // A light background needs darker text, and the reverse.
  const darken = backgroundLuminance !== null && backgroundLuminance < 2;

  let channels = [
    Number.parseInt((parsed[1] as string).slice(0, 2), 16),
    Number.parseInt((parsed[1] as string).slice(2, 4), 16),
    Number.parseInt((parsed[1] as string).slice(4, 6), 16),
  ];

  for (let step = 0; step < 40; step += 1) {
    const candidate = `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    const ratio = contrastRatio(candidate, background);
    if (ratio !== null && ratio >= required) return candidate;

    channels = channels.map((channel) =>
      darken ? Math.min(255, channel + 8) : Math.max(0, channel - 8),
    );
  }

  // Fall back to the extreme that is guaranteed to pass.
  return darken ? '#ffffff' : '#000000';
}

export function resolveTheme(base: Theme, overrides?: ThemeOverrides): ResolvedTheme {
  const merged = mergeTheme(base, overrides);

  // Re-validated after merging. An override arrives from user input, so the
  // merged result is untrusted until it passes the schema again.
  const parsed = ThemeSchema.safeParse(merged);
  if (!parsed.success) {
    // An invalid override falls back to the template's own theme rather than
    // failing the render: a broken colour must not take an invitation down.
    return { theme: base, warnings: checkThemeContrast(base), adjusted: false };
  }

  const theme = parsed.data;
  const warnings = checkThemeContrast(theme);
  if (warnings.length === 0) return { theme, warnings, adjusted: false };

  const guarded: Theme = {
    ...theme,
    colors: {
      ...theme.colors,
      textPrimary: adjustForContrast(
        theme.colors.textPrimary,
        theme.colors.background,
        WCAG_AA_NORMAL_TEXT,
      ),
      textSecondary: adjustForContrast(
        theme.colors.textSecondary,
        theme.colors.background,
        WCAG_AA_NORMAL_TEXT,
      ),
    },
  };

  return { theme: guarded, warnings, adjusted: true };
}
