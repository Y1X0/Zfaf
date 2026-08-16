import { type Theme, adjustToContrast, readableForegroundOn } from '@zfaf/core';

/**
 * Turning a theme into CSS custom properties.
 *
 * This is the one place where validated data becomes a stylesheet, so it is the
 * one place a CSS-injection bug could exist. Two defences, both required:
 *
 *   1. Values come from a schema-validated `Theme` — every colour matched a hex
 *      or rgb() pattern, every keyword came from a closed set.
 *   2. Every value is re-checked here anyway, and anything unrecognised is
 *      replaced by a safe default rather than emitted.
 *
 * The second check is not redundant. It is what holds if a snapshot written by
 * an older schema, or altered outside the application, reaches this function.
 */

/** Matches only what may appear as a CSS colour. No functions, no expressions. */
const SAFE_COLOR = /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([\d\s,.]+\))$/;

/** Font stacks are looked up, never interpolated from input. */
const FONT_STACKS: Readonly<Record<string, string>> = {
  'aref-ruqaa': '"Aref Ruqaa", "Amiri", Georgia, serif',
  amiri: '"Amiri", Georgia, serif',
  'reem-kufi': '"Reem Kufi", "Tajawal", sans-serif',
  'ibm-plex-arabic': '"IBM Plex Sans Arabic", "Tajawal", system-ui, sans-serif',
  tajawal: '"Tajawal", system-ui, sans-serif',
  cairo: '"Cairo", system-ui, sans-serif',
  'cormorant-garamond': '"Cormorant Garamond", Georgia, serif',
  'playfair-display': '"Playfair Display", Georgia, serif',
  inter: '"Inter", system-ui, sans-serif',
};

const SPACING_SCALE: Readonly<Record<string, string>> = {
  tight: 'clamp(2rem, 5vw, 3.5rem)',
  normal: 'clamp(3rem, 8vw, 6rem)',
  airy: 'clamp(4rem, 11vw, 8rem)',
};

const RADIUS_SCALE: Readonly<Record<string, string>> = {
  sharp: '0px',
  soft: '8px',
  round: '20px',
  pill: '999px',
};

const TYPE_SCALE: Readonly<Record<string, { display: string; body: string; lead: string }>> = {
  compact: { display: 'clamp(2rem, 8vw, 3rem)', body: '1rem', lead: '1.7' },
  normal: { display: 'clamp(2.5rem, 11vw, 4.5rem)', body: '1.0625rem', lead: '1.9' },
  generous: { display: 'clamp(3rem, 14vw, 6rem)', body: '1.125rem', lead: '2' },
};

const MOTION_DURATION: Readonly<Record<string, string>> = {
  none: '0ms',
  subtle: '450ms',
  moderate: '650ms',
  rich: '900ms',
};

function safeColor(value: string, fallback: string): string {
  return SAFE_COLOR.test(value) ? value : fallback;
}

function lookup(table: Readonly<Record<string, string>>, key: string, fallback: string): string {
  return Object.hasOwn(table, key) ? (table[key] as string) : fallback;
}

/**
 * Produces the CSS custom properties for a theme.
 *
 * Returned as ordered pairs rather than a string so the caller controls
 * serialisation, and so the output is trivially assertable in tests.
 */
export function themeToCssVariables(theme: Theme): ReadonlyArray<readonly [string, string]> {
  const typeScale = lookup(
    TYPE_SCALE as unknown as Record<string, string>,
    theme.typography.scale,
    'normal',
  );
  const scale =
    TYPE_SCALE[theme.typography.scale] ??
    (TYPE_SCALE['normal'] as { display: string; body: string; lead: string });
  void typeScale;

  const primary = safeColor(theme.colors.primary, '#b8860b');
  const background = safeColor(theme.colors.background, '#ffffff');

  return [
    ['--zf-color-primary', primary],
    ['--zf-color-secondary', safeColor(theme.colors.secondary, '#1b1b1b')],
    ['--zf-color-accent', safeColor(theme.colors.accent, '#e8d9a0')],
    ['--zf-color-bg', background],
    /**
     * The foreground for anything sitting **on** the primary colour: solid
     * buttons, the RSVP submit, the hero seal, the share control.
     *
     * It is the background colour whenever that is legible — which is the case
     * for every shipped template, so nothing about their appearance changes —
     * and black or white when it is not. Hard-coding `--zf-color-bg` there is
     * what put white-on-gold at 3.2:1 on a customised palette, failing WCAG AA
     * on the one control a guest has to press.
     */
    ['--zf-color-on-primary', readableForegroundOn(primary, background)],
    /**
     * The primary colour used as **text** on the page background — the map
     * link, the music toggle's label.
     *
     * Distinct from `--zf-color-primary` because the same colour has two
     * different requirements: as a fill or a border or a display-sized numeral
     * it only has to clear 3:1, and as ordinary-sized text it has to clear
     * 4.5:1. Templates sit comfortably above both, so this is identical to
     * `--zf-color-primary` for all of them; a customised gold on ivory is where
     * they part company.
     */
    ['--zf-color-primary-text', adjustToContrast(primary, background)],
    ['--zf-color-surface', safeColor(theme.colors.surface, '#ffffff')],
    ['--zf-color-text', safeColor(theme.colors.textPrimary, '#111111')],
    ['--zf-color-text-muted', safeColor(theme.colors.textSecondary, '#555555')],
    ['--zf-color-overlay', safeColor(theme.colors.overlay, 'rgba(0,0,0,0.5)')],

    [
      '--zf-font-display',
      lookup(FONT_STACKS, theme.typography.displayFont, FONT_STACKS['inter'] as string),
    ],
    [
      '--zf-font-body',
      lookup(FONT_STACKS, theme.typography.bodyFont, FONT_STACKS['inter'] as string),
    ],
    ['--zf-font-display-weight', String(theme.typography.displayWeight)],
    ['--zf-font-size-display', scale.display],
    ['--zf-font-size-body', scale.body],
    // Arabic needs more leading than Latin: diacritics and dots need the room.
    ['--zf-line-height', scale.lead],

    ['--zf-space-section', lookup(SPACING_SCALE, theme.spacing, SPACING_SCALE['normal'] as string)],
    ['--zf-radius', lookup(RADIUS_SCALE, theme.radius, RADIUS_SCALE['soft'] as string)],

    ['--zf-motion-duration', lookup(MOTION_DURATION, theme.motion.intensity, '450ms')],
    ['--zf-motion-ease', 'cubic-bezier(0.22, 0.61, 0.36, 1)'],
  ];
}

/**
 * Serialises the variables into a `:root` rule.
 *
 * Property names are fixed literals and values have already been constrained,
 * so no part of this string originates from user input verbatim. The
 * `prefers-reduced-motion` block is emitted unconditionally: honouring the
 * setting must not depend on a template remembering to ask for it (ADR-0010).
 */
export function themeToStyleSheet(theme: Theme): string {
  const declarations = themeToCssVariables(theme)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');

  return `:root{${declarations}}@media (prefers-reduced-motion:reduce){:root{--zf-motion-duration:0ms}}`;
}
