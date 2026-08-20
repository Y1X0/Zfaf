import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';

import { type PublishedSnapshot, createSnapshot, requireMarket } from '@zfaf/core';

import { InvitationRenderer, type RenderOptions } from '../render/InvitationRenderer.js';
import { validateManifest } from '../validate/validate-manifest.js';

/**
 * Fixtures shared by the renderer's test suites.
 *
 * They build snapshots from the *shipped* manifests rather than from
 * hand-written section lists, so a test that passes is evidence about the
 * templates we actually publish, not about a fixture that resembles them.
 */

const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates');

/**
 * The fixture's time zone comes from the market registry rather than a literal.
 *
 * Not only to satisfy `zfaf/no-market-literals`: a fixture that hard-codes
 * Riyadh would keep passing after the market layer stopped being consulted,
 * which is exactly the regression ADR-0015 exists to catch.
 */
const FIXTURE_TIMEZONE = requireMarket('SA').defaultTimezone;

export const TEMPLATE_KEYS = ['classic-luxury', 'royal-gold', 'minimal-white'] as const;

export function manifestFor(key: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(templatesDir, key, 'manifest.json'), 'utf8'));
}

/** Deep-merges an override object onto the base content. Arrays are replaced. */
function mergeContent(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      merged[key] = mergeContent(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export interface SnapshotOverrides {
  readonly content?: Record<string, unknown>;
  readonly locale?: 'ar' | 'en';
  readonly sections?: readonly Record<string, unknown>[];
}

/** Builds a snapshot from a shipped manifest, so tests exercise real templates. */
export function snapshotFrom(
  templateKey: string,
  overrides: SnapshotOverrides = {},
): PublishedSnapshot {
  const validated = validateManifest(manifestFor(templateKey));
  if (!validated.ok || !validated.manifest) {
    throw new Error(`manifest ${templateKey} is invalid: ${JSON.stringify(validated.issues)}`);
  }

  const result = createSnapshot({
    schemaVersion: 1,
    templateKey: validated.manifest.key,
    templateVersion: validated.manifest.version,
    locale: overrides.locale ?? 'ar',
    timezone: FIXTURE_TIMEZONE,
    theme: validated.manifest.theme,
    sections:
      overrides.sections ??
      validated.manifest.sections.map((section) => ({
        id: section.id,
        type: section.type,
        variant: section.variant,
        enabled: section.enabled,
        order: section.order,
        props: section.props,
      })),
    content: mergeContent(baseContent(), overrides.content ?? {}),
    publishedAt: '2026-08-16T10:00:00.000Z',
  });

  if (!result.ok) throw new Error(`snapshot invalid: ${JSON.stringify(result.errors)}`);
  return result.snapshot;
}

export function baseContent(): Record<string, unknown> {
  return {
    couple: {
      groomName: 'أحمد',
      brideName: 'سارة',
      shortName: 'أ & س',
      message: 'بكل الحب ندعوكم لمشاركتنا أجمل أيام حياتنا',
      photo: {
        id: 'm1',
        url: 'https://cdn.zfaf.app/couple.avif',
        width: 1080,
        height: 1350,
        blurhash: null,
        alt: 'العروسان',
      },
    },
    wedding: { date: '2026-09-20', startTime: '20:00', endTime: null, timezone: FIXTURE_TIMEZONE },
    location: {
      venueName: 'قاعة النخيل',
      address: 'طريق الملك فهد، الرياض',
      latitude: 24.7136,
      longitude: 46.6753,
      mapsUrl: 'https://maps.google.com/?q=24.7136,46.6753',
    },
    events: [
      {
        id: 'e1',
        type: 'wedding',
        title: 'حفل الزفاف',
        description: 'يشرفنا حضوركم',
        date: '2026-09-20',
        startTime: '20:00',
        endTime: '23:30',
        timezone: FIXTURE_TIMEZONE,
        venueName: 'قاعة النخيل',
        venueAddress: null,
        mapsUrl: null,
        sortOrder: 2,
      },
      {
        id: 'e2',
        type: 'contract',
        title: 'عقد القران',
        description: null,
        date: '2026-09-19',
        startTime: '18:00',
        endTime: null,
        timezone: FIXTURE_TIMEZONE,
        venueName: 'جامع عمّان الكبير',
        venueAddress: null,
        mapsUrl: null,
        sortOrder: 1,
      },
    ],
    cover: {
      id: 'c1',
      url: 'https://cdn.zfaf.app/cover.avif',
      width: 1920,
      height: 1080,
      blurhash: null,
      alt: null,
    },
    gallery: [
      { id: 'g1', url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Cdefs%3E%3ClinearGradient id='g1'%3E%3Cstop offset='0%25' style='stop-color:%23d9c9ae'/%3E%3Cstop offset='100%25' style='stop-color:%23faf8f3'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='800' fill='url(%23g1)'/%3E%3Ctext x='400' y='420' font-size='120' font-weight='bold' font-family='Arial' text-anchor='middle' fill='%238a6c3f'%3E1%3C/text%3E%3C/svg%3E", width: 800, height: 800, blurhash: null, alt: null },
      { id: 'g2', url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Cdefs%3E%3ClinearGradient id='g2'%3E%3Cstop offset='0%25' style='stop-color:%23d9c9ae'/%3E%3Cstop offset='100%25' style='stop-color:%23faf8f3'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='800' fill='url(%23g2)'/%3E%3Ctext x='400' y='420' font-size='120' font-weight='bold' font-family='Arial' text-anchor='middle' fill='%238a6c3f'%3E2%3C/text%3E%3C/svg%3E", width: 800, height: 800, blurhash: null, alt: null },
      { id: 'g3', url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Cdefs%3E%3ClinearGradient id='g3'%3E%3Cstop offset='0%25' style='stop-color:%23d9c9ae'/%3E%3Cstop offset='100%25' style='stop-color:%23faf8f3'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='800' fill='url(%23g3)'/%3E%3Ctext x='400' y='420' font-size='120' font-weight='bold' font-family='Arial' text-anchor='middle' fill='%238a6c3f'%3E3%3C/text%3E%3C/svg%3E", width: 800, height: 800, blurhash: null, alt: null },
      { id: 'g4', url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Cdefs%3E%3ClinearGradient id='g4'%3E%3Cstop offset='0%25' style='stop-color:%23d9c9ae'/%3E%3Cstop offset='100%25' style='stop-color:%23faf8f3'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='800' fill='url(%23g4)'/%3E%3Ctext x='400' y='420' font-size='120' font-weight='bold' font-family='Arial' text-anchor='middle' fill='%238a6c3f'%3E4%3C/text%3E%3C/svg%3E", width: 800, height: 800, blurhash: null, alt: null },
      { id: 'g5', url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Cdefs%3E%3ClinearGradient id='g5'%3E%3Cstop offset='0%25' style='stop-color:%23d9c9ae'/%3E%3Cstop offset='100%25' style='stop-color:%23faf8f3'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='800' fill='url(%23g5)'/%3E%3Ctext x='400' y='420' font-size='120' font-weight='bold' font-family='Arial' text-anchor='middle' fill='%238a6c3f'%3E5%3C/text%3E%3C/svg%3E", width: 800, height: 800, blurhash: null, alt: null },
      { id: 'g6', url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800'%3E%3Cdefs%3E%3ClinearGradient id='g6'%3E%3Cstop offset='0%25' style='stop-color:%23d9c9ae'/%3E%3Cstop offset='100%25' style='stop-color:%23faf8f3'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='800' height='800' fill='url(%23g6)'/%3E%3Ctext x='400' y='420' font-size='120' font-weight='bold' font-family='Arial' text-anchor='middle' fill='%238a6c3f'%3E6%3C/text%3E%3C/svg%3E", width: 800, height: 800, blurhash: null, alt: null },
    ],
    music: {
      trackId: 't1',
      url: 'https://cdn.zfaf.app/track.m4a',
      title: 'Oud',
      attribution: 'CC0',
    },
    rsvp: { enabled: true, deadline: '2026-09-15', maxPartySize: 5 },
  };
}

export function render(
  snapshot: PublishedSnapshot,
  mode: 'preview' | 'published' = 'published',
  options: Omit<RenderOptions, 'mode'> = {},
): string {
  return renderToStaticMarkup(<InvitationRenderer snapshot={snapshot} mode={mode} {...options} />);
}
