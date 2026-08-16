'use client';

import type { ReactElement } from 'react';

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
export const PALETTES = [
  {
    id: 'classic-gold',
    label: 'ذهبي كلاسيكي',
    colors: { primary: '#8a6d24', accent: '#d9c89a', secondary: '#2f2a24' },
  },
  {
    id: 'royal-night',
    label: 'ليلي فخم',
    colors: { primary: '#c9a227', accent: '#6b5a2a', secondary: '#0e0e0e' },
  },
  {
    id: 'blush',
    label: 'وردي هادئ',
    colors: { primary: '#a8586b', accent: '#e8ccd2', secondary: '#3a2b2f' },
  },
  {
    id: 'sage',
    label: 'أخضر مريمية',
    colors: { primary: '#4f6b52', accent: '#cdd9c8', secondary: '#26302a' },
  },
  {
    id: 'ink',
    label: 'حبري بسيط',
    colors: { primary: '#1f2937', accent: '#cbd5e1', secondary: '#0f172a' },
  },
  {
    id: 'terracotta',
    label: 'طيني دافئ',
    colors: { primary: '#9c5b3c', accent: '#e6c6b1', secondary: '#3b2a22' },
  },
] as const;

const MOTION_LEVELS = [
  { value: 'none', label: 'بلا' },
  { value: 'subtle', label: 'خفيفة' },
  { value: 'moderate', label: 'متوسطة' },
  { value: 'rich', label: 'غنية' },
] as const;

export function DesignPanel({ document, builder }: PanelProps): ReactElement {
  const warnings = checkThemeContrast(document.theme);
  const activePalette = PALETTES.find(
    (palette) => palette.colors.primary === document.theme.colors.primary,
  );

  return (
    <section className="zfb-panel" aria-labelledby="zfb-design-heading" data-testid="design-panel">
      <h2 className="zfb-panel__summary" id="zfb-design-heading">
        التصميم
      </h2>
      <div className="zfb-panel__body">
        <div className="zfb-field">
          <span className="zfb-field__label">مجموعات جاهزة</span>
          <div className="zfb-swatches" role="group" aria-label="مجموعات ألوان جاهزة">
            {PALETTES.map((palette) => (
              <button
                key={palette.id}
                type="button"
                className="zfb-swatch"
                data-testid={`palette-${palette.id}`}
                aria-pressed={activePalette?.id === palette.id}
                onClick={() => builder.edit('مجموعة ألوان', edits.themePalette(palette.colors))}
              >
                <span className="zfb-swatch__chips" aria-hidden="true">
                  {Object.values(palette.colors).map((color) => (
                    <span key={color} className="zfb-swatch__chip" style={{ background: color }} />
                  ))}
                </span>
                {palette.label}
              </button>
            ))}
          </div>
        </div>

        <div className="zfb-row">
          <div className="zfb-field">
            <label className="zfb-field__label" htmlFor="zfb-color-primary">
              اللون الأساسي
            </label>
            <input
              id="zfb-color-primary"
              className="zfb-field__input"
              data-testid="color-primary"
              type="color"
              value={document.theme.colors.primary}
              onChange={(event) =>
                builder.edit(
                  'اللون الأساسي',
                  edits.themeColor({ key: 'primary', color: event.target.value }),
                )
              }
            />
          </div>
          <div className="zfb-field">
            <label className="zfb-field__label" htmlFor="zfb-color-accent">
              اللون المميز
            </label>
            <input
              id="zfb-color-accent"
              className="zfb-field__input"
              type="color"
              value={document.theme.colors.accent}
              onChange={(event) =>
                builder.edit(
                  'اللون المميز',
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
            هذا التباين سيصعّب القراءة على بعض الضيوف. جرّب لوناً أغمق أو أفتح.
          </p>
        ) : null}

        <div className="zfb-row">
          <div className="zfb-field">
            <label className="zfb-field__label" htmlFor="zfb-font-display">
              خط العناوين
            </label>
            <select
              id="zfb-font-display"
              className="zfb-field__select"
              data-testid="font-display"
              value={document.theme.typography.displayFont}
              onChange={(event) =>
                builder.edit(
                  'خط العناوين',
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
              خط النص
            </label>
            <select
              id="zfb-font-body"
              className="zfb-field__select"
              value={document.theme.typography.bodyFont}
              onChange={(event) =>
                builder.edit(
                  'خط النص',
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
          <legend className="zfb-field__label">شدّة الحركة</legend>
          <div className="zfb-swatches">
            {MOTION_LEVELS.map((level) => (
              <button
                key={level.value}
                type="button"
                className="zfb-swatch"
                data-testid={`motion-${level.value}`}
                aria-pressed={document.theme.motion.intensity === level.value}
                onClick={() => builder.edit('الحركة', edits.themeMotion(level.value))}
              >
                {level.label}
              </button>
            ))}
          </div>
        </fieldset>

        <details className="zfb-panel">
          <summary className="zfb-panel__summary">خيارات متقدمة</summary>
          <div className="zfb-panel__body zfb-row">
            <div className="zfb-field">
              <label className="zfb-field__label" htmlFor="zfb-spacing">
                التباعد
              </label>
              <select
                id="zfb-spacing"
                className="zfb-field__select"
                value={document.theme.spacing}
                onChange={(event) =>
                  builder.edit('التباعد', edits.themeSpacing(event.target.value))
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
                الزوايا
              </label>
              <select
                id="zfb-radius"
                className="zfb-field__select"
                value={document.theme.radius}
                onChange={(event) => builder.edit('الزوايا', edits.themeRadius(event.target.value))}
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

const SECTION_LABELS: Readonly<Record<string, string>> = {
  hero: 'الافتتاحية',
  couple: 'العروسان',
  countdown: 'العد التنازلي',
  events: 'برنامج الحفل',
  location: 'الموقع',
  gallery: 'المعرض',
  story: 'قصتنا',
  rsvp: 'تأكيد الحضور',
  message: 'رسالة',
  music: 'الموسيقى',
  footer: 'الخاتمة',
};

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
  // Sorted by `order` so the list matches the invitation, not the array.
  const ordered = [...document.sections].sort((a, b) => a.order - b.order);

  const move = (position: number, direction: -1 | 1) => {
    const target = ordered[position + direction];
    const current = ordered[position];
    if (!target || !current) return;

    builder.edit('ترتيب الأقسام', [
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
        الأقسام
      </h2>
      <div className="zfb-panel__body">
        <ul className="zfb-sections">
          {ordered.map((section, position) => {
            const locked = LOCKED_TYPES.has(section.type);
            const label = SECTION_LABELS[section.type] ?? section.type;
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
                  aria-label={`نقل ${label} للأعلى`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="zfb-btn zfb-btn--icon"
                  data-testid={`section-down-${section.id}`}
                  onClick={() => move(position, 1)}
                  disabled={position === ordered.length - 1}
                  aria-label={`نقل ${label} للأسفل`}
                >
                  ↓
                </button>

                {locked ? (
                  <span className="zfb-sections__locked">مقفل</span>
                ) : (
                  <button
                    type="button"
                    className="zfb-btn zfb-btn--icon"
                    data-testid={`section-toggle-${section.id}`}
                    aria-pressed={section.enabled}
                    onClick={() =>
                      builder.edit(
                        section.enabled ? `إخفاء ${label}` : `إظهار ${label}`,
                        edits.sectionEnabled({ index, enabled: !section.enabled }),
                      )
                    }
                    aria-label={section.enabled ? `إخفاء ${label}` : `إظهار ${label}`}
                  >
                    {section.enabled ? '👁' : '🚫'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="zfb-field__hint">
          الأقسام الظاهرة الآن: {visible.size} من {document.sections.length}
        </p>
      </div>
    </section>
  );
}
