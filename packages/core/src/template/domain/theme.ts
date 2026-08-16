import { z } from 'zod';

/**
 * Theme tokens (ADR-0004).
 *
 * Theme values become CSS custom properties injected into the page, which makes
 * them an injection surface: a value such as `red; } body { display:none` would
 * escape its declaration if passed through verbatim. Every value is therefore
 * constrained to an enumeration or a strict pattern — never a free string.
 */

/** `#rgb`, `#rrggbb` or `#rrggbbaa`. Nothing else may reach a stylesheet. */
export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Must be a hex colour');

/** `rgba(r, g, b, a)` with numeric components only. */
export const RgbaColorSchema = z
  .string()
  .regex(
    /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/,
    'Must be an rgb()/rgba() colour',
  );

export const ColorSchema = z.union([HexColorSchema, RgbaColorSchema]);

/**
 * Fonts are chosen from a registry, not named freely.
 *
 * A free-form font name would be both an injection vector and a licensing
 * problem; every font we ship is OFL-licensed and self-hosted
 * (docs/07-frontend-architecture.md §5).
 */
export const FONT_KEYS = [
  'aref-ruqaa',
  'amiri',
  'reem-kufi',
  'ibm-plex-arabic',
  'tajawal',
  'cairo',
  'cormorant-garamond',
  'playfair-display',
  'inter',
] as const;

export type FontKey = (typeof FONT_KEYS)[number];
export const FontKeySchema = z.enum(FONT_KEYS);

export const MOTION_EFFECTS = ['petals', 'sparkle', 'float', 'parallax', 'waxSeal'] as const;

export const ThemeSchema = z
  .object({
    colors: z
      .object({
        primary: ColorSchema,
        secondary: ColorSchema,
        accent: ColorSchema,
        background: ColorSchema,
        surface: ColorSchema,
        textPrimary: ColorSchema,
        textSecondary: ColorSchema,
        overlay: ColorSchema,
      })
      .strict(),

    typography: z
      .object({
        displayFont: FontKeySchema,
        bodyFont: FontKeySchema,
        scale: z.enum(['compact', 'normal', 'generous']),
        displayWeight: z.number().int().min(100).max(900),
      })
      .strict(),

    spacing: z.enum(['tight', 'normal', 'airy']),
    radius: z.enum(['sharp', 'soft', 'round', 'pill']),
    buttons: z.enum(['solid', 'outline', 'ghost', 'gradient']),
    dividers: z.enum(['none', 'line', 'ornament', 'floral', 'geometric']),

    background: z
      .object({
        kind: z.enum(['solid', 'gradient', 'pattern', 'image']),
        // An asset key from our own registry, never an arbitrary URL.
        value: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Must be an asset key'),
        overlayOpacity: z.number().min(0).max(1),
      })
      .strict(),

    motion: z
      .object({
        intensity: z.enum(['none', 'subtle', 'moderate', 'rich']),
        effects: z.array(z.enum(MOTION_EFFECTS)).max(4),
      })
      .strict(),

    /** Latin by default in this region; see decision #12. */
    numerals: z.enum(['latin', 'arabic-indic']),
  })
  .strict();

export type Theme = z.infer<typeof ThemeSchema>;

/** A user's partial customisation of a template's theme. */
export const ThemeOverridesSchema = ThemeSchema.deepPartial();
export type ThemeOverrides = z.infer<typeof ThemeOverridesSchema>;

// ── Contrast ────────────────────────────────────────────────────────────────

function parseHex(color: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color);
  if (!match) return null;
  let hex = match[1] as string;
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const channel = (raw: number): number => {
    const value = raw / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG 2.1 contrast ratio, or null when either colour is not a hex value. */
export function contrastRatio(foreground: string, background: string): number | null {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  if (first === null || second === null) return null;
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3;

export interface ContrastWarning {
  readonly pair: string;
  readonly ratio: number;
  readonly required: number;
}

/**
 * Reports theme colour pairs that fall below WCAG AA.
 *
 * Reports rather than rejects: the builder shows the warning and offers a
 * corrected colour, because refusing a bride's chosen palette outright is worse
 * product behaviour than telling her it will be hard to read
 * (docs/05-template-engine.md §6).
 */
export function checkThemeContrast(theme: Theme): readonly ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  const pairs: ReadonlyArray<readonly [string, string, string, number]> = [
    [
      'textPrimary/background',
      theme.colors.textPrimary,
      theme.colors.background,
      WCAG_AA_NORMAL_TEXT,
    ],
    [
      'textSecondary/background',
      theme.colors.textSecondary,
      theme.colors.background,
      WCAG_AA_NORMAL_TEXT,
    ],
    ['textPrimary/surface', theme.colors.textPrimary, theme.colors.surface, WCAG_AA_NORMAL_TEXT],
    ['primary/background', theme.colors.primary, theme.colors.background, WCAG_AA_LARGE_TEXT],
  ];

  for (const [pair, foreground, background, required] of pairs) {
    const ratio = contrastRatio(foreground, background);
    if (ratio !== null && ratio < required) {
      warnings.push({ pair, ratio: Math.round(ratio * 100) / 100, required });
    }
  }
  return warnings;
}
