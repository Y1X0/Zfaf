'use client';

import type { ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import { type DraftDocument, FONT_KEYS, checkThemeContrast, enabledSections } from '@zfaf/core';

import { edits } from './edits.js';
import type { BuilderApi } from './useBuilder.js';

/**
 * The design and sections panels (D5.9, D5.10).
 *
 * Both are available from anywhere in the wizard rather than being steps of
 * their own, because they are things a couple returns to repeatedly rather
 * than completing once.
 */

export interface PanelProps {
  readonly document: DraftDocument;
  readonly builder: BuilderApi;
}

/**
 * Ready-made palettes, offered before the colour pickers.
 *
 * Most people want "something beautiful", not a hue slider. Putting the
 * pickers first makes the common case the hard one (docs/06 §6).
 */
/**
 * Palette ids map to message keys, not to words.
 *
 * The id is what a preset is identified by everywhere else in the product; the
 * key is derived from it once, here, so adding a palette means adding a colour
 * set and two translations rather than remembering a third mapping table.
 */
const PALETTE_KEYS: Readonly<Record<string, string>> = {
  'classic-gold': 'classicGold',
  'royal-night': 'midnight',
  blush: 'dustyRose',
  sage: 'sageGreen',
  ink: 'ink',
  terracotta: 'terracotta',
};

export const PALETTES = [
  {
    id: 'classic-gold',
    colors: { primary: '#8a6d24', accent: '#d9c89a', secondary: '#2f2a24' },
  },
  {
    id: 'royal-night',
    colors: { primary: '#c9a227', accent: '#6b5a2a', secondary: '#0e0e0e' },
  },
  {
    id: 'blush',
    colors: { primary: '#a8586b', accent: '#e8ccd2', secondary: '#3a2b2f' },
  },
  {
    id: 'sage',
    colors: { primary: '#4f6b52', accent: '#cdd9c8', secondary: '#26302a' },
  },
  {
    id: 'ink',
    colors: { primary: '#1f2937', accent: '#cbd5e1', secondary: '#0f172a' },
  },
  {
    id: 'terracotta',
    colors: { primary: '#9c5b3c', accent: '#e6c6b1', secondary: '#3b2a22' },
  },
] as const;

/**
 * Motion levels, as values only.
 *
 * The stored value never changes; the word beside it is looked up per render,
 * so a document written in Arabic reads correctly to an English collaborator
 * without either of them touching the document.
 */
const MOTION_LEVELS = ['none', 'subtle', 'moderate', 'rich'] as const;

export function DesignPanel({ document, builder }: PanelProps): ReactElement {
  const t = useTranslations('builder.design');
  const warnings = checkThemeContrast(document.theme);
  const activePalette = PALETTES.find(
    (palette) => palette.colors.primary === document.theme.colors.primary,
  );

  return (
    <section className="zfb-panel" aria-labelledby="zfb-design-heading" data-testid="design-panel">
      <h2 className="zfb-panel__summary" id="zfb-design-heading">
        {t('panelTitle')}
      </h2>
      <div className="zfb-panel__body">
        <div className="zfb-field">
          <span className="zfb-field__label">{t('presets')}</span>
          <div className="zfb-swatches" role="group" aria-label={t('paletteGroup')}>
            {PALETTES.map((palette) => (
              <button
                key={palette.id}
                type="button"
                className="zfb-swatch"
                data-testid={`palette-${palette.id}`}
                aria-pressed={activePalette?.id === palette.id}
                onClick={() => builder.edit('theme.palette', edits.themePalette(palette.colors))}
              >
                <span className="zfb-swatch__chips" aria-hidden="true">
                  {Object.values(palette.colors).map((color) => (
                    <span key={color} className="zfb-swatch__chip" style={{ background: color }} />
                  ))}
                </span>
                {t(`palettes.${PALETTE_KEYS[palette.id] ?? 'ink'}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="zfb-row">
          <div className="zfb-field">
            <label className="zfb-field__label" htmlFor="zfb-color-primary">
              {t('primary')}
            </label>
            <input
              id="zfb-color-primary"
              className="zfb-field__input"
              data-testid="color-primary"
              type="color"
              value={document.theme.colors.primary}
              onChange={(event) =>
                builder.edit(
                  'theme.primary',
                  edits.themeColor({ key: 'primary', color: event.target.value }),
                )
              }
            />
          </div>
          <div className="zfb-field">
            <label className="zfb-field__label" htmlFor="zfb-color-accent">
              {t('accent')}
            </label>
            <input
              id="zfb-color-accent"
              className="zfb-field__input"
              type="color"
              value={document.theme.colors.accent}
              onChange={(event) =>
                builder.edit(
                  'theme.accent',
                  edits.themeColor({ key: 'accent', color: event.target.value }),
                )
              }
            />
          </div>
        </div>

        {warnings.length > 0 ? (
          // Shown the moment a colour is chosen rather than at publish time,
          // when changing it means going back through the whole flow.
          <p className="zfb-contrast-warning" role="status" data-testid="contrast-warning">
            {t('contrastWarning')}
          </p>
        ) : null}

        <div className="zfb-row">
          <div className="zfb-field">
            <label className="zfb-field__label" htmlFor="zfb-font-display">
              {t('headingFont')}
            </label>
            <select
              id="zfb-font-display"
              className="zfb-field__select"
              data-testid="font-display"
              value={document.theme.typography.displayFont}
              onChange={(event) =>
                builder.edit(
                  'theme.headingFont',
                  edits.themeFont({ key: 'displayFont', font: event.target.value }),
                )
              }
            >
              {FONT_KEYS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </div>
          <div className="zfb-field">
            <label className="zfb-field__label" htmlFor="zfb-font-body">
              {t('bodyFont')}
            </label>
            <select
              id="zfb-font-body"
              className="zfb-field__select"
              value={document.theme.typography.bodyFont}
              onChange={(event) =>
                builder.edit(
                  'theme.bodyFont',
                  edits.themeFont({ key: 'bodyFont', font: event.target.value }),
                )
              }
            >
              {FONT_KEYS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="zfb-field">
          <legend className="zfb-field__label">{t('motionLevel')}</legend>
          <div className="zfb-swatches">
            {MOTION_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className="zfb-swatch"
                data-testid={`motion-${level}`}
                aria-pressed={document.theme.motion.intensity === level}
                onClick={() => builder.edit('theme.motion', edits.themeMotion(level))}
              >
                {t(`scale.${level}`)}
              </button>
            ))}
          </div>
        </fieldset>

        <details className="zfb-panel">
          <summary className="zfb-panel__summary">{t('advanced')}</summary>
          <div className="zfb-panel__body zfb-row">
            <div className="zfb-field">
              <label className="zfb-field__label" htmlFor="zfb-spacing">
                {t('spacing')}
              </label>
              <select
                id="zfb-spacing"
                className="zfb-field__select"
                value={document.theme.spacing}
                onChange={(event) =>
                  builder.edit('theme.spacing', edits.themeSpacing(event.target.value))
                }
              >
                {['tight', 'normal', 'airy'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="zfb-field">
              <label className="zfb-field__label" htmlFor="zfb-radius">
                {t('corners')}
              </label>
              <select
                id="zfb-radius"
                className="zfb-field__select"
                value={document.theme.radius}
                onChange={(event) =>
                  builder.edit('theme.radius', edits.themeRadius(event.target.value))
                }
              >
                {['sharp', 'soft', 'round', 'pill'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}

// ── sections ───────────────────────────────────────────────────────────────

/** Types an invitation cannot open or close without. */
const LOCKED_TYPES = new Set(['hero', 'footer']);

/**
 * The sections panel (D5.10).
 *
 * Reordering is arrow buttons, not drag and drop. Drag works badly on touch,
 * needs separate keyboard and screen-reader affordances to be accessible at
 * all, and costs days rather than hours. Arrows give most of the value and are
 * accessible for free; `dnd-kit` is a Phase 2 change with no data migration
 * behind it (docs/06 §7).
 */
export function SectionsPanel({ document, builder }: PanelProps): ReactElement {
  const t = useTranslations('builder.sections');
  // Sorted by `order` so the list matches the invitation, not the array.
  const ordered = [...document.sections].sort((a, b) => a.order - b.order);

  const move = (position: number, direction: -1 | 1) => {
    const target = ordered[position + direction];
    const current = ordered[position];
    if (!target || !current) return;

    builder.edit('sections.order', [
      {
        op: 'replace',
        path: `/sections/${document.sections.indexOf(current)}/order`,
        value: target.order,
      },
      {
        op: 'replace',
        path: `/sections/${document.sections.indexOf(target)}/order`,
        value: current.order,
      },
    ]);
  };

  const visible = new Set(enabledSections(document.sections).map((section) => section.id));

  return (
    <section
      className="zfb-panel"
      aria-labelledby="zfb-sections-heading"
      data-testid="sections-panel"
    >
      <h2 className="zfb-panel__summary" id="zfb-sections-heading">
        {t('panelTitle')}
      </h2>
      <div className="zfb-panel__body">
        <ul className="zfb-sections">
          {ordered.map((section, position) => {
            const locked = LOCKED_TYPES.has(section.type);
            /**
             * The section's own type is the message key.
             *
             * A type with no translation falls back to the type itself rather
             * than to an empty button — an untranslated word is a bug worth
             * seeing, a blank control is a bug nobody can report.
             */
            const label = t.has(section.type) ? t(section.type) : section.type;
            const index = document.sections.indexOf(section);

            return (
              <li
                key={section.id}
                className={`zfb-sections__item${section.enabled ? '' : ' zfb-sections__item--off'}`}
                data-testid={`section-${section.id}`}
              >
                <span className="zfb-sections__name">{label}</span>

                <button
                  type="button"
                  className="zfb-btn zfb-btn--icon"
                  data-testid={`section-up-${section.id}`}
                  onClick={() => move(position, -1)}
                  disabled={position === 0}
                  aria-label={t('moveUp', { name: label })}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="zfb-btn zfb-btn--icon"
                  data-testid={`section-down-${section.id}`}
                  onClick={() => move(position, 1)}
                  disabled={position === ordered.length - 1}
                  aria-label={t('moveDown', { name: label })}
                >
                  ↓
                </button>

                {locked ? (
                  <span className="zfb-sections__locked">{t('locked')}</span>
                ) : (
                  <button
                    type="button"
                    className="zfb-btn zfb-btn--icon"
                    data-testid={`section-toggle-${section.id}`}
                    aria-pressed={section.enabled}
                    onClick={() =>
                      builder.edit(
                        section.enabled ? 'sections.hide' : 'sections.show',
                        edits.sectionEnabled({ index, enabled: !section.enabled }),
                      )
                    }
                    aria-label={
                      section.enabled ? t('hide', { name: label }) : t('show', { name: label })
                    }
                  >
                    {section.enabled ? '👁' : '🚫'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="zfb-field__hint">
          {t('visibleCount', { visible: visible.size, total: document.sections.length })}
        </p>
      </div>
    </section>
  );
}
