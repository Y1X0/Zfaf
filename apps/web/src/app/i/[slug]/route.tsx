import { getEnv } from '@zfaf/config';
import {
  PUBLIC_ACCESS_STATUS,
  UNAVAILABLE_RESPONSE_POLICY,
  previewCopy,
  publicInvitationUrl,
  publicResponsePolicy,
  resolvePublicAccess,
} from '@zfaf/core';

import { container } from '../../../server/container.js';
import type { UnavailableKind } from '../../../public-page/UnavailableDocument.js';

/**
 * The published invitation (D6.4, ADR-0020).
 *
 * A Route Handler rather than a page, because this response ships **no
 * client-side React at all**. Next's App Router loads a 100 KB client runtime
 * on any page, which alone exceeds the approved 90 KB budget for this route
 * before a line of our own code. Serving hand-assembled HTML keeps the budget
 * that was approved instead of raising it to match the framework — the
 * reasoning, the alternatives, and the cost are in ADR-0020.
 *
 * The one thing that must not be lost in the trade is M3's fail-soft
 * guarantee: a section whose component throws must not take the page down,
 * because a guest seeing a blank page the night of a wedding is
 * unrecoverable. That is why this streams through `renderToReadableStream`
 * rather than using `renderToStaticMarkup` — error boundaries only contain a
 * throw during a streaming render.
 */

export const dynamic = 'force-dynamic';
// Node, not Edge: the response reads PostgreSQL through Prisma.
export const runtime = 'nodejs';

/**
 * The renderer is imported at call time, not at module scope.
 *
 * Next refuses a static import of `react-dom/server` from application code,
 * because in a normal app that import means someone is about to render inside
 * a component — a real mistake. Here it is what the route is *for*: this
 * handler has no component tree above it and produces the whole document
 * itself. The dynamic form is the sanctioned way to say so, and the module is
 * cached after the first call.
 */
const documentModule = () => import('../../../public-page/InvitationDocument.js');
const unavailableModule = () => import('../../../public-page/UnavailableDocument.js');

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const { invitations, clock } = container();

  const view = await invitations.findPublishedBySlug(slug);

  if (!view) {
    /**
     * A renamed slug still resolves.
     *
     * The old link is already in hundreds of WhatsApp threads and printed on
     * QR codes that cannot be reissued (ADR-0013, ADR-0016). 301 rather than
     * 302 so intermediaries learn the new address permanently.
     */
    const current = await invitations.findSlugRedirect(slug);
    if (current) {
      return new Response(null, {
        status: PUBLIC_ACCESS_STATUS.REDIRECT,
        headers: {
          location: publicInvitationUrl(baseUrl(request), current),
          // Not cached: the target can change again, and a cached permanent
          // redirect is very hard to take back.
          'cache-control': 'no-store',
        },
      });
    }
    return await unavailable('NOT_FOUND');
  }

  const access = resolvePublicAccess({
    status: view.status,
    expiresAt: view.expiresAt,
    now: clock.now(),
  });

  if (access.kind !== 'VISIBLE') {
    return await unavailable(access.kind);
  }

  // ── the visible invitation ────────────────────────────────────────────────

  const policy = publicResponsePolicy(view.visibility);
  const canonicalUrl = publicInvitationUrl(baseUrl(request), slug);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const serverNow = clock.now().toISOString();

  const copy = previewCopy({
    groomName: view.snapshot.content.couple.groomName,
    brideName: view.snapshot.content.couple.brideName,
    locale: view.snapshot.locale,
    date: view.snapshot.content.wedding.date,
    timezone: view.snapshot.content.wedding.timezone,
    venueName: view.snapshot.content.location.venueName,
  });

  const { renderInvitationDocument } = await documentModule();
  const rendered = await renderInvitationDocument({
    snapshot: view.snapshot,
    canonicalUrl,
    ogImageUrl: `${canonicalUrl}/og`,
    robots: policy.robots,
    nonce,
    serverNow,
    title: copy.title,
    description: copy.description,
  });

  // A section that throws is dropped and the rest of the invitation still
  // reaches the guest — M3's fail-soft guarantee, kept here by rendering each
  // section separately rather than by a React error boundary. It is still
  // logged, because a section failing in production is something we need to
  // see even though the guest must not.
  for (const sectionId of rendered.failedSections) {
    console.error(`[invitation] section "${sectionId}" failed to render`, {
      invitationId: view.invitationId,
    });
  }

  return new Response(rendered.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': policy.cacheControl,
      // Lets a CDN purge exactly this invitation on republish rather than
      // waiting out the TTL.
      'cache-tag': `invitation:${view.invitationId}`,
      'content-security-policy': contentSecurityPolicy(nonce),
      'x-robots-tag': policy.robots,
      ...HARDENING_HEADERS,
    },
  });
}

async function unavailable(kind: UnavailableKind): Promise<Response> {
  const html = await renderToStaticDocument(kind);
  return new Response(html, {
    status: PUBLIC_ACCESS_STATUS[kind],
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': UNAVAILABLE_RESPONSE_POLICY.cacheControl,
      'x-robots-tag': UNAVAILABLE_RESPONSE_POLICY.robots,
      // No nonce needed: this document carries one static stylesheet and no
      // script at all, so the policy can be stricter than the main page's.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...HARDENING_HEADERS,
    },
  });
}

/**
 * Renders the unavailable document to a string.
 *
 * Synchronous, unlike the invitation itself: there are no section components
 * here to fail, so there is nothing for a streaming render's error boundaries
 * to contain, and a missing slug is exactly the request a scanner hammers.
 */
async function renderToStaticDocument(kind: UnavailableKind): Promise<string> {
  const [{ renderToStaticMarkup }, { UnavailableDocument }] = await Promise.all([
    import('react-dom/server'),
    unavailableModule(),
  ]);
  return `<!DOCTYPE html>${renderToStaticMarkup(<UnavailableDocument kind={kind} />)}`;
}

/**
 * The strictest policy in the product (docs/12 §4).
 *
 * `default-src 'none'` and then only what the page genuinely uses. Note what
 * is absent: no `unsafe-inline`, no external origin of any kind — no font CDN,
 * no embedded map, no third-party analytics. The theme's inline `<style>` is
 * covered by the nonce rather than by an exception.
 */
function contentSecurityPolicy(nonce: string): string {
  const media = mediaOrigin();
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: ${media}`.trim(),
    `media-src 'self' ${media}`.trim(),
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    // Not embeddable anywhere: an invitation inside someone else's frame is a
    // phishing surface, and there is no legitimate reason to allow it.
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** Where photographs and audio come from, as an origin rather than a full URL. */
function mediaOrigin(): string {
  try {
    return new URL(getEnv().STORAGE_PUBLIC_BASE_URL).origin;
  } catch {
    return '';
  }
}

const HARDENING_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  // Stricter here than the site default: a guest following a link from a
  // private chat should not leak the invitation's address to anything the page
  // touches.
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
};

/**
 * The public origin.
 *
 * Configuration first, because the canonical URL, the QR payload and the
 * `og:url` must agree with the address on printed cards — and a request header
 * is attacker-controlled. The request is only a fallback for environments
 * where the variable is not set.
 */
function baseUrl(request: Request): string {
  try {
    return getEnv().PUBLIC_BASE_URL;
  } catch {
    return new URL(request.url).origin;
  }
}
