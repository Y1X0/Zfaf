import type { ReactElement } from 'react';

import type { RenderContent, ResolvedImage } from '../registry/types.js';

/**
 * Small pieces shared by section variants.
 *
 * Keeping them here is what stops the same markup being reimplemented per
 * template — the failure mode ADR-0004 exists to prevent. A fix to date
 * formatting or image loading lands once and reaches every template.
 */

/** Section wrapper. Every variant uses it, so spacing is consistent by construction. */
export function SectionShell({
  sectionId,
  variantClass,
  landmark,
  children,
}: {
  sectionId: string;
  variantClass: string;
  landmark?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <section
      id={`section-${sectionId}`}
      data-section={sectionId}
      className={`zf-section ${variantClass}`}
      {...(landmark ? { role: landmark } : {})}
    >
      <div className="zf-section__inner">{children}</div>
    </section>
  );
}

/**
 * A media URL we will emit into a `src` attribute.
 *
 * `z.string().url()` on the snapshot accepts any parsable URL, `javascript:`
 * and `data:` included — it validates syntax, not scheme. Browsers do not
 * execute those from `<img>` or `<audio>`, so this is not the last line of
 * defence, but a scheme check here means an attacker-shaped snapshot cannot
 * put an arbitrary URI in front of a guest at all.
 */
export function safeMediaUrl(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * An image.
 *
 * `width` and `height` are always emitted so the browser reserves space and the
 * page does not shift as images arrive — CLS is a hard budget on the public
 * page (docs/07-frontend-architecture.md §10).
 *
 * Renders nothing when the URL is not one we will emit: a missing photo is a
 * gap in a page, an unchecked URI is a hole in a page.
 */
export function Picture({
  image,
  className,
  priority = false,
  sizes = '100vw',
}: {
  image: ResolvedImage;
  className?: string;
  priority?: boolean;
  sizes?: string;
}): ReactElement | null {
  const src = safeMediaUrl(image.url);
  if (!src) return null;

  return (
    <img
      src={src}
      alt={image.alt ?? ''}
      {...(image.width !== null ? { width: image.width } : {})}
      {...(image.height !== null ? { height: image.height } : {})}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={priority ? 'high' : 'auto'}
      sizes={sizes}
      className={className ?? 'zf-image'}
    />
  );
}

/** Divider whose form follows the theme, so templates differ without new code. */
export function Divider(): ReactElement {
  return <div className="zf-divider" aria-hidden="true" />;
}

/**
 * The locale tag every displayed date and time is formatted with.
 *
 * **`ca-gregory` is pinned, and that is a correctness fix rather than a
 * preference.** `ar-SA` carries `islamic-umalqura` as its default calendar in
 * current CLDR, and runtimes disagree about it: Node resolves `ar-SA` to
 * `gregory`, Chromium resolves the same tag to `islamic-umalqura`. So one
 * wedding date, from one document, produced two different strings —
 *
 *     server:  الأربعاء، 18 أغسطس 2027
 *     client:  الأربعاء، 16 ربيع الأول 1449 هـ
 *
 * — which surfaced as a React hydration mismatch in the builder preview, and
 * is worse than a warning: the preview a couple approves would not be the page
 * a guest opens, and two guests on different browsers could read different
 * dates off the same invitation. A runtime upgrade could also silently
 * restyle every date already in circulation.
 *
 * Gregorian is what the stored value *is*: `content.wedding.date` is
 * `YYYY-MM-DD`, the builder collects it with a Gregorian date picker, and the
 * countdown counts to the Gregorian instant. Showing a Hijri date would be a
 * product decision nobody has made — and it must not be made by accident.
 *
 * The numbering system stays configurable, because that is a genuine theme
 * choice (`theme.numerals`) rather than a change of calendar.
 */
export function displayLocaleTag(locale: 'ar' | 'en', numerals: 'latin' | 'arabic-indic'): string {
  if (locale !== 'ar') return 'en-GB-u-ca-gregory';
  return `ar-SA-u-nu-${numerals === 'latin' ? 'latn' : 'arab'}-ca-gregory`;
}

/**
 * Formats a date for display.
 *
 * Uses `Intl` with an explicit time zone rather than string manipulation.
 * Formatting a wedding date in the viewer's zone instead of the event's is the
 * classic way a date silently shifts by a day.
 */
export function formatEventDate(
  date: string,
  timezone: string,
  locale: 'ar' | 'en',
  numerals: 'latin' | 'arabic-indic',
): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  const tag = displayLocaleTag(locale, numerals);

  return new Intl.DateTimeFormat(tag, {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(instant);
}

export function formatTime(
  time: string | null,
  locale: 'ar' | 'en',
  numerals: 'latin' | 'arabic-indic',
): string | null {
  if (!time) return null;
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const instant = new Date(Date.UTC(2000, 0, 1, hour, minute));
  const tag = displayLocaleTag(locale, numerals);

  return new Intl.DateTimeFormat(tag, {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: locale === 'ar',
  }).format(instant);
}

/**
 * Map hosts we will link to.
 *
 * An allowlist rather than a URL check: a link on an invitation is trusted by
 * guests, which makes an open redirect here a phishing primitive
 * (docs/12-security-threat-model.md §3-T).
 */
const ALLOWED_MAP_HOSTS: readonly string[] = [
  'google.com',
  'www.google.com',
  'maps.google.com',
  'goo.gl',
  'maps.app.goo.gl',
  'maps.apple.com',
  'openstreetmap.org',
  'www.openstreetmap.org',
];

export function safeMapUrl(candidate: string | null): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    // Protocol first: `javascript:` never reaches an href.
    if (url.protocol !== 'https:') return null;
    return ALLOWED_MAP_HOSTS.includes(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The couple's display name, honouring a short form when the template wants one. */
export function coupleNames(content: RenderContent, preferShort: boolean): string {
  if (preferShort && content.couple.shortName) return content.couple.shortName;
  return `${content.couple.groomName} & ${content.couple.brideName}`;
}
