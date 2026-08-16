import {
  type ContrastWarning,
  type Theme,
  type ThemeOverrides,
  ThemeSchema,
  adjustToContrast,
  checkThemeContrast,
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
 * Adjusts rather than rejects. Refusing a bride's chosen palette outright is
 * worse product behaviour than telling her it will be hard to read and offering
 * the nearest colour that works (docs/05-template-engine.md §6).
 *
 * The walk itself lives in `@zfaf/core` alongside `contrastRatio`, so the
 * builder's preview, this guard and the rendered stylesheet cannot drift apart
 * — the local copy that used to live here walked the wrong way and never
 * converged.
 */

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
      textPrimary: adjustToContrast(
        theme.colors.textPrimary,
        theme.colors.background,
        WCAG_AA_NORMAL_TEXT,
      ),
      textSecondary: adjustToContrast(
        theme.colors.textSecondary,
        theme.colors.background,
        WCAG_AA_NORMAL_TEXT,
      ),
    },
  };

  return { theme: guarded, warnings, adjusted: true };
}
