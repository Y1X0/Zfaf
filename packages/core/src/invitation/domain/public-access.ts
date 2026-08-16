import type { InvitationStatus } from './invitation-status.js';
import { publicVisibilityFor } from './invitation-status.js';

/**
 * What an anonymous visitor is served for a given slug (D6.4, D6.5).
 *
 * A pure decision, kept out of the route handler for two reasons. The first is
 * testability: "a suspended invitation must not render" is a security
 * property, and a security property tested through an HTTP round trip is
 * tested weakly. The second is that the three ways an invitation can be
 * unavailable mean genuinely different things, and conflating them is both a
 * usability failure and an information leak:
 *
 *   • **410 Gone** — it existed, it is over. Honest for a wedding that has
 *     passed; a guest who bookmarked it deserves to know rather than to think
 *     they mistyped.
 *   • **451 Unavailable For Legal Reasons** — removed by moderation. Saying
 *     "gone" would be a lie, and saying "not found" would hide an action we
 *     are accountable for.
 *   • **404 Not Found** — everything else, deliberately indistinguishable.
 *     A draft, a paused invitation and a deleted one all answer the same way,
 *     because confirming that a slug exists but is unpublished tells a
 *     stranger about an invitation that is none of their business.
 */

export type PublicAccessOutcome =
  | { readonly kind: 'VISIBLE' }
  | { readonly kind: 'REDIRECT'; readonly slug: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'GONE' }
  | { readonly kind: 'BLOCKED' };

export interface PublicAccessInput {
  readonly status: InvitationStatus;
  readonly expiresAt: Date | null;
  /** Read once by the caller and passed in, so the decision stays pure. */
  readonly now: Date;
}

/**
 * The outcomes this decision can produce.
 *
 * `REDIRECT` is absent because it is not a property of the invitation — it is
 * what the route does when no invitation answers to the slug at all, which is
 * a question this function is never asked.
 */
export type PublicAccessVerdict = Exclude<PublicAccessOutcome, { kind: 'REDIRECT' }>;

export function resolvePublicAccess(input: PublicAccessInput): PublicAccessVerdict {
  const base = publicVisibilityFor(input.status);

  // Moderation outranks expiry: a suspended invitation that also happens to
  // have expired is still a moderation outcome, and reporting it as merely
  // "gone" would understate what happened.
  if (base === 'BLOCKED') return { kind: 'BLOCKED' };

  /**
   * Expiry is evaluated here rather than trusted from `status`.
   *
   * A nightly job flips PUBLISHED to EXPIRED, so between the moment an
   * invitation expires and the moment that job runs, the row still says
   * PUBLISHED. Serving it during that window would mean the expiry date means
   * "some time tomorrow" rather than what it says.
   */
  if (
    base === 'VISIBLE' &&
    input.expiresAt !== null &&
    input.expiresAt.getTime() <= input.now.getTime()
  ) {
    return { kind: 'GONE' };
  }

  // `BLOCKED` has already returned above, so the compiler has narrowed it away
  // — which is why it is absent here rather than forgotten.
  switch (base) {
    case 'VISIBLE':
      return { kind: 'VISIBLE' };
    case 'GONE':
      return { kind: 'GONE' };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
  }
}

export const PUBLIC_ACCESS_STATUS: Readonly<Record<PublicAccessOutcome['kind'], number>> = {
  VISIBLE: 200,
  // 301 rather than 302: the old slug is permanently the wrong address, and a
  // permanent redirect is what lets a printed QR code keep working after the
  // caches along the way have forgotten us (ADR-0016).
  REDIRECT: 301,
  NOT_FOUND: 404,
  GONE: 410,
  BLOCKED: 451,
};

// ── caching and indexing (ADR-0017) ─────────────────────────────────────────

export type Visibility = 'UNLISTED' | 'INDEXED' | 'PROTECTED';

export interface PublicResponsePolicy {
  readonly cacheControl: string;
  readonly robots: string;
  /** Whether the slug may appear in a sitemap. */
  readonly indexable: boolean;
}

/**
 * Response policy for a visible invitation.
 *
 * `UNLISTED` is **not private** and the platform must never behave as though
 * it were. It is cached at the edge exactly like an indexed invitation,
 * because anyone holding the link may open it — the only difference is that
 * search engines are asked not to list it.
 *
 * `PROTECTED` is the one that cannot be cached, and that is a consequence of
 * the security model rather than a tuning choice: a shared cache holding a
 * credential-gated page would serve it to the next visitor without the
 * credential.
 */
export function publicResponsePolicy(visibility: Visibility): PublicResponsePolicy {
  switch (visibility) {
    case 'INDEXED':
      return {
        cacheControl: 'public, s-maxage=300, stale-while-revalidate=86400',
        robots: 'index, follow',
        indexable: true,
      };
    case 'UNLISTED':
      return {
        cacheControl: 'public, s-maxage=300, stale-while-revalidate=86400',
        robots: 'noindex, nofollow',
        indexable: false,
      };
    case 'PROTECTED':
      return { cacheControl: 'private, no-store', robots: 'noindex, nofollow', indexable: false };
  }
}

/** Nothing that is not a live, visible invitation may be cached or indexed. */
export const UNAVAILABLE_RESPONSE_POLICY: PublicResponsePolicy = {
  cacheControl: 'no-store',
  robots: 'noindex, nofollow',
  indexable: false,
};

// ── links (D6.7, D6.8) ──────────────────────────────────────────────────────

/**
 * The public address of an invitation.
 *
 * One function, because this string is encoded into printed QR codes, pasted
 * into WhatsApp, and written into `og:url`. Three copies of the same
 * concatenation is how a printed code ends up pointing somewhere the share
 * sheet does not.
 */
export function publicInvitationUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/i/${encodeURIComponent(slug)}`;
}

export interface ShareTextInput {
  readonly groomName: string;
  readonly brideName: string;
  readonly url: string;
  readonly locale: 'ar' | 'en';
}

/**
 * The message pre-filled when an owner shares.
 *
 * Kept in the domain and not in a component because it is content, it is
 * translated, and the URL must be the *last* thing in it — WhatsApp only
 * renders a link preview for a URL that ends the message, and a share that
 * loses its preview loses most of its effect.
 */
export function shareText(input: ShareTextInput): string {
  const couple =
    input.locale === 'ar'
      ? `${input.groomName} و${input.brideName}`
      : `${input.groomName} & ${input.brideName}`;

  const invitation =
    input.locale === 'ar'
      ? `يسرّنا دعوتكم لحضور حفل زفاف ${couple}`
      : `You are invited to the wedding of ${couple}`;

  return `${invitation}\n${input.url}`;
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// ── link preview copy (D6.6) ────────────────────────────────────────────────

export interface PreviewCopyInput {
  readonly groomName: string;
  readonly brideName: string;
  readonly locale: 'ar' | 'en';
  readonly date: string;
  readonly timezone: string;
  readonly venueName: string | null;
}

export interface PreviewCopy {
  readonly title: string;
  readonly description: string;
}

/**
 * The title and description a link preview shows.
 *
 * Derived from the snapshot rather than stored, so it cannot drift from what
 * the page says. It is also the only text most WhatsApp recipients read before
 * deciding whether to open the link, which is why the couple's names come
 * first and the platform's name does not appear at all.
 */
export function previewCopy(input: PreviewCopyInput): PreviewCopy {
  const couple =
    input.locale === 'ar'
      ? `${input.groomName} و${input.brideName}`
      : `${input.groomName} & ${input.brideName}`;

  const title = input.locale === 'ar' ? `دعوة زفاف ${couple}` : `${couple} — Wedding Invitation`;

  const when = formatEventDate(input.date, input.locale, input.timezone);
  const description = input.venueName
    ? input.locale === 'ar'
      ? `${when} · ${input.venueName}`
      : `${when} · ${input.venueName}`
    : when;

  return { title, description };
}

/**
 * The date, in the invitation's own language and zone.
 *
 * The zone matters even for a date-only string: `2026-09-20` formatted in the
 * server's zone can render as the 19th for a guest, and an invitation naming
 * the wrong day is the worst kind of small bug.
 */
function formatEventDate(date: string, locale: 'ar' | 'en', timezone: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(`${date}T12:00:00.000Z`));
  } catch {
    // An unknown zone must not take down a link preview.
    return date;
  }
}
