import { previewCopy, resolvePublicAccess } from '@zfaf/core';

import { container } from '../../../../server/container.js';
import {
  OG_HEIGHT,
  OG_WIDTH,
  renderFallbackOgImage,
  renderOgImage,
} from '../../../../public-page/og-image.js';

/**
 * The link preview image for one invitation (D6.6).
 *
 * Served from the invitation's own path so a CDN purge of the invitation
 * naturally covers its card too.
 *
 * The whole route is wrapped so that a failure produces the fallback card
 * rather than an error status. WhatsApp does not retry: a 500 here means the
 * link is shared with no preview at all, forever, for everyone who received
 * that message. A plain card is a far better outcome than a bare link, and
 * the difference is not recoverable afterwards.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Long enough that a chat app's scraper is not regenerating on every share. */
const CACHE_CONTROL = 'public, s-maxage=86400, stale-while-revalidate=604800';

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await context.params;
    const { invitations, clock } = container();

    const view = await invitations.findPublishedBySlug(slug);
    const access = view
      ? resolvePublicAccess({ status: view.status, expiresAt: view.expiresAt, now: clock.now() })
      : { kind: 'NOT_FOUND' as const };

    if (!view || access.kind !== 'VISIBLE') {
      // A card for an invitation nobody may see must not disclose it. The
      // generic one says only that this is a wedding invitation, which is
      // already implied by the link.
      return image(renderFallbackOgImage(), 'no-store');
    }

    const { snapshot } = view;
    const copy = previewCopy({
      groomName: snapshot.content.couple.groomName,
      brideName: snapshot.content.couple.brideName,
      locale: snapshot.locale,
      date: snapshot.content.wedding.date,
      timezone: snapshot.content.wedding.timezone,
      venueName: snapshot.content.location.venueName,
    });

    return image(
      renderOgImage({
        title: copy.title,
        subtitle: copy.description,
        locale: snapshot.locale,
        colors: {
          background: snapshot.theme.colors.background,
          primary: snapshot.theme.colors.primary,
          text: snapshot.theme.colors.textPrimary,
          muted: snapshot.theme.colors.textSecondary,
        },
      }),
      CACHE_CONTROL,
    );
  } catch (error) {
    console.error('[og] falling back to the generic card', error);
    return image(renderFallbackOgImage(), 'no-store');
  }
}

function image(png: Buffer, cacheControl: string): Response {
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': cacheControl,
      'content-length': String(png.byteLength),
      'x-image-size': `${OG_WIDTH}x${OG_HEIGHT}`,
      'x-content-type-options': 'nosniff',
    },
  });
}
