'use client';

import { type ReactElement, useId } from 'react';
import { useTranslations } from 'next-intl';

import type { DraftDocument } from '@zfaf/core';

import { edits } from './edits.js';
import type { BuilderApi } from './useBuilder.js';

/**
 * The wizard steps (D5.2–D5.4).
 *
 * Three rules shape every one of them, from docs/06 §1 and §3:
 *
 *   • **Three to five fields, not fifteen.** Anything advanced sits behind a
 *     `<details>` a user can ignore. The minimum publishable invitation is two
 *     names and a date.
 *   • **An empty section disappears from the invitation** rather than showing
 *     "no photos yet". So a couple who skips a step still gets a coherent
 *     result, and skipping needs no explanation.
 *   • **Every control is a real form control.** Native inputs are keyboard
 *     accessible, announce themselves to screen readers, and bring the right
 *     mobile keyboard — none of which a styled `<div>` does.
 */

export interface StepProps {
  readonly document: DraftDocument;
  readonly builder: BuilderApi;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactElement;
}): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="zfb-field">
      <label className="zfb-field__label" htmlFor={id}>
        {label}
      </label>
      {children(id, hint ? hintId : undefined)}
      {hint ? (
        <p className="zfb-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ── 1. the couple ──────────────────────────────────────────────────────────

export function CoupleStep({ document, builder }: StepProps): ReactElement {
  const { couple } = document.content;
  const t = useTranslations('builder.couple');

  return (
    <div className="zfb-form">
      <div className="zfb-row">
        <Field label={t('groomName')}>
          {(id) => (
            <input
              id={id}
              className="zfb-field__input"
              data-testid="groom-name"
              value={couple.groomName}
              onChange={(event) =>
                builder.edit('couple.groomName', edits.groomName(event.target.value))
              }
              maxLength={80}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label={t('brideName')}>
          {(id) => (
            <input
              id={id}
              className="zfb-field__input"
              data-testid="bride-name"
              value={couple.brideName}
              onChange={(event) =>
                builder.edit('couple.brideName', edits.brideName(event.target.value))
              }
              maxLength={80}
              autoComplete="off"
            />
          )}
        </Field>
      </div>

      <Field label={t('message')} hint={t('messageHint')}>
        {(id, describedBy) => (
          <textarea
            id={id}
            className="zfb-field__textarea"
            data-testid="couple-message"
            value={couple.message ?? ''}
            onChange={(event) =>
              builder.edit('couple.message', edits.coupleMessage(event.target.value))
            }
            maxLength={2000}
            {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          />
        )}
      </Field>

      <details className="zfb-panel">
        <summary className="zfb-panel__summary">{t('more')}</summary>
        <div className="zfb-panel__body">
          <Field label={t('shortName')} hint={t('shortNameHint')}>
            {(id, describedBy) => (
              <input
                id={id}
                className="zfb-field__input"
                value={couple.shortName ?? ''}
                onChange={(event) =>
                  builder.edit('couple.shortName', edits.shortName(event.target.value))
                }
                maxLength={40}
                {...(describedBy ? { 'aria-describedby': describedBy } : {})}
              />
            )}
          </Field>
        </div>
      </details>
    </div>
  );
}

// ── 2. the date ────────────────────────────────────────────────────────────

/**
 * Time zones we offer by name.
 *
 * The browser's own zone is detected and offered first, because asking someone
 * to pick an IANA identifier from a list of six hundred is asking them to
 * guess. It is always shown rather than applied silently: a wedding an hour
 * out is not a mistake anyone catches by reading a form
 * (docs/06 §3, "المنطقة الزمنية").
 */
function detectedTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function DateStep({ document, builder }: StepProps): ReactElement {
  const t = useTranslations('builder.date');
  const { wedding } = document.content;
  const detected = detectedTimezone();
  // The invitation's own zone comes first; it was set from the market when the
  // invitation was created (ADR-0015), so there is no default to hard-code
  // here — doing so would reintroduce the assumption the market layer removes.
  const zones = [...new Set([wedding.timezone, detected].filter(Boolean))] as string[];

  return (
    <div className="zfb-form">
      <Field label={t('weddingDate')}>
        {(id) => (
          <input
            id={id}
            className="zfb-field__input"
            data-testid="wedding-date"
            type="date"
            value={wedding.date ?? ''}
            onChange={(event) =>
              builder.edit('wedding.date', edits.weddingDate(event.target.value))
            }
          />
        )}
      </Field>

      <div className="zfb-row">
        <Field label={t('startTime')}>
          {(id) => (
            <input
              id={id}
              className="zfb-field__input"
              data-testid="wedding-start-time"
              type="time"
              value={wedding.startTime ?? ''}
              onChange={(event) =>
                builder.edit('wedding.startTime', edits.weddingStartTime(event.target.value))
              }
            />
          )}
        </Field>
        <Field label={t('endTime')}>
          {(id) => (
            <input
              id={id}
              className="zfb-field__input"
              type="time"
              value={wedding.endTime ?? ''}
              onChange={(event) =>
                builder.edit('wedding.endTime', edits.weddingEndTime(event.target.value))
              }
            />
          )}
        </Field>
      </div>

      <Field
        label={t('timezone')}
        hint={
          wedding.startTime
            ? t('timezoneAt', { time: wedding.startTime, zone: wedding.timezone })
            : t('timezoneHint')
        }
      >
        {(id, describedBy) => (
          <select
            id={id}
            className="zfb-field__select"
            data-testid="wedding-timezone"
            value={wedding.timezone}
            onChange={(event) =>
              builder.edit('wedding.timezone', edits.timezone(event.target.value))
            }
            {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
                {zone === detected ? ` ${t('deviceZone')}` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  );
}

// ── 3. the venue ───────────────────────────────────────────────────────────

/**
 * Pulls coordinates out of a pasted Google Maps link.
 *
 * The real input is a link, because an ordinary user does not know their
 * venue's latitude. Raw coordinate fields stay behind "advanced"
 * (docs/06 §3, "الإحداثيات").
 */
export function parseMapsCoordinates(url: string): { latitude: number; longitude: number } | null {
  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (!match) continue;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) return { latitude, longitude };
  }
  return null;
}

export function LocationStep({ document, builder }: StepProps): ReactElement {
  const t = useTranslations('builder.location');
  const { location } = document.content;

  return (
    <div className="zfb-form">
      <Field label={t('venueName')}>
        {(id) => (
          <input
            id={id}
            className="zfb-field__input"
            data-testid="venue-name"
            value={location.venueName ?? ''}
            onChange={(event) =>
              builder.edit('location.venueName', edits.venueName(event.target.value))
            }
            maxLength={200}
          />
        )}
      </Field>

      <Field label={t('address')}>
        {(id) => (
          <input
            id={id}
            className="zfb-field__input"
            value={location.address ?? ''}
            onChange={(event) =>
              builder.edit('location.address', edits.venueAddress(event.target.value))
            }
            maxLength={500}
          />
        )}
      </Field>

      <Field label={t('mapsUrl')} hint={t('mapsUrlHint')}>
        {(id, describedBy) => (
          <input
            id={id}
            className="zfb-field__input"
            data-testid="maps-url"
            type="url"
            inputMode="url"
            value={location.mapsUrl ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              builder.edit('location.mapsUrl', edits.mapsUrl(value));
              const parsed = parseMapsCoordinates(value);
              if (parsed) builder.edit('location.coordinates', edits.coordinates(parsed));
            }}
            {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          />
        )}
      </Field>

      <details className="zfb-panel">
        <summary className="zfb-panel__summary">{t('advanced')}</summary>
        <div className="zfb-panel__body zfb-row">
          <Field label={t('latitude')}>
            {(id) => (
              <input
                id={id}
                className="zfb-field__input"
                type="number"
                step="any"
                value={location.latitude ?? ''}
                onChange={(event) =>
                  builder.edit('location.latitude', [
                    {
                      op: 'replace',
                      path: '/content/location/latitude',
                      value: event.target.value === '' ? null : Number(event.target.value),
                    },
                  ])
                }
              />
            )}
          </Field>
          <Field label={t('longitude')}>
            {(id) => (
              <input
                id={id}
                className="zfb-field__input"
                type="number"
                step="any"
                value={location.longitude ?? ''}
                onChange={(event) =>
                  builder.edit('location.longitude', [
                    {
                      op: 'replace',
                      path: '/content/location/longitude',
                      value: event.target.value === '' ? null : Number(event.target.value),
                    },
                  ])
                }
              />
            )}
          </Field>
        </div>
      </details>
    </div>
  );
}

// ── 4. the programme ───────────────────────────────────────────────────────

/**
 * The event kinds, as keys.
 *
 * The value is what the document stores and must never change; the label is
 * looked up per render, so the same stored `contract` reads "عقد القران" or
 * "Contract signing" without the document knowing which language it is being
 * shown in.
 */
const EVENT_TYPES = ['contract', 'reception', 'wedding', 'dinner', 'custom'] as const;

export function EventsStep({ document, builder }: StepProps): ReactElement {
  const t = useTranslations('builder.events');
  const { events, wedding } = document.content;

  const addEvent = () => {
    builder.edit('events.add', [
      {
        op: 'add',
        path: '/content/events/-',
        value: {
          // Stable and collision-free without a network round trip. The id is
          // opaque and never shown.
          id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
          type: 'wedding',
          title: '',
          description: null,
          date: wedding.date ?? new Date().toISOString().slice(0, 10),
          startTime: null,
          endTime: null,
          timezone: wedding.timezone,
          venueName: null,
          venueAddress: null,
          mapsUrl: null,
          sortOrder: events.length,
        },
      },
    ]);
  };

  return (
    <div className="zfb-form">
      <p className="zfb-field__hint">{t('hint')}</p>

      {events.map((event, index) => (
        <fieldset key={event.id} className="zfb-panel" data-testid="event-item">
          <legend className="zfb-visually-hidden">{t('item', { number: index + 1 })}</legend>
          <div className="zfb-panel__body">
            <Field label={t('title')}>
              {(id) => (
                <input
                  id={id}
                  className="zfb-field__input"
                  data-testid="event-title"
                  value={event.title}
                  onChange={(changed) =>
                    builder.edit(
                      'events.title',
                      edits.eventField({ index, field: 'title', next: changed.target.value }),
                    )
                  }
                  maxLength={120}
                />
              )}
            </Field>

            <div className="zfb-row">
              <Field label={t('type')}>
                {(id) => (
                  <select
                    id={id}
                    className="zfb-field__select"
                    value={event.type}
                    onChange={(changed) =>
                      builder.edit(
                        'events.type',
                        edits.eventField({ index, field: 'type', next: changed.target.value }),
                      )
                    }
                  >
                    {EVENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`types.${type}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('date')}>
                {(id) => (
                  <input
                    id={id}
                    className="zfb-field__input"
                    type="date"
                    value={event.date}
                    onChange={(changed) =>
                      builder.edit(
                        'events.date',
                        edits.eventField({ index, field: 'date', next: changed.target.value }),
                      )
                    }
                  />
                )}
              </Field>
            </div>

            <button
              type="button"
              className="zfb-btn"
              data-testid="remove-event"
              onClick={() => builder.edit('events.remove', edits.removeEvent(index))}
            >
              {t('remove')}
            </button>
          </div>
        </fieldset>
      ))}

      <button type="button" className="zfb-btn" data-testid="add-event" onClick={addEvent}>
        {t('add')}
      </button>
    </div>
  );
}

// ── 5. photographs ─────────────────────────────────────────────────────────

/**
 * The photographs step (D5.3).
 *
 * Uploading goes through the three-stage flow built in M4: the browser
 * compresses, asks for a signed URL, PUTs straight to storage, then confirms.
 * The file never passes through our servers — see docs/10 §4.
 */
export function PhotosStep({ document, builder }: StepProps): ReactElement {
  const t = useTranslations('builder.photos');
  const { gallery, cover } = document.content;

  return (
    <div className="zfb-form">
      <p className="zfb-field__hint">{t('hint')}</p>

      <div className="zfb-field">
        <span className="zfb-field__label">{t('cover')}</span>
        {cover ? (
          <div className="zfb-sections__item">
            <span className="zfb-sections__name">{cover.alt ?? t('cover')}</span>
            <button
              type="button"
              className="zfb-btn zfb-btn--icon"
              onClick={() => builder.edit('photos.removeCover', edits.setCover(null))}
              aria-label={t('removeCover')}
            >
              ✕
            </button>
          </div>
        ) : (
          <p className="zfb-field__hint">{t('noCover')}</p>
        )}
      </div>

      <div className="zfb-field">
        <span className="zfb-field__label">{t('gallery', { count: gallery.length })}</span>
        <ul className="zfb-sections" data-testid="gallery-list">
          {gallery.map((image, index) => (
            <li key={image.id} className="zfb-sections__item">
              <span className="zfb-sections__name">
                {image.alt ?? t('image', { number: index + 1 })}
              </span>
              <button
                type="button"
                className="zfb-btn zfb-btn--icon"
                onClick={() => builder.edit('photos.removeImage', edits.removeGalleryImage(index))}
                aria-label={t('removeImage', { number: index + 1 })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>

      <p className="zfb-field__hint" data-testid="upload-note">
        {t('uploadNote')}
      </p>
    </div>
  );
}

// ── 6. music ───────────────────────────────────────────────────────────────

/**
 * The music step (D5.4).
 *
 * Choosing from a curated library, never uploading. Publishing music a couple
 * uploaded makes us the publisher of whatever they chose, and that is the
 * largest legal exposure in the product (ADR-0012, docs/10 §8).
 */
export function MusicStep({ document, builder }: StepProps): ReactElement {
  const t = useTranslations('builder.music');
  const { music } = document.content;

  return (
    <div className="zfb-form">
      <p className="zfb-field__hint">{t('hint')}</p>

      <div className="zfb-field">
        <span className="zfb-field__label">{t('selected')}</span>
        <p data-testid="selected-track">{music.title ?? t('none')}</p>
        {music.trackId ? (
          <button
            type="button"
            className="zfb-btn"
            onClick={() =>
              builder.edit(
                'music.remove',
                edits.music({ trackId: null, url: null, title: null, attribution: null }),
              )
            }
          >
            {t('remove')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
