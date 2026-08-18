import type { StorageKey } from '@zfaf/shared';
import { container } from '../../../server/container.js';

/**
 * Private media redirect (ADR-0025).
 *
 * Guests cannot download directly from the private B2 bucket. This route
 * validates media keys and issues short-lived signed URLs, then redirects
 * the browser to B2 so the file transfer bypasses the app server.
 *
 * Only public-display media keys are allowed: `media/<uuid>/<uuid>/<uuid>/w<digits>.<ext>`.
 * Internal keys like `original.bin` are rejected to prevent serving raw uploads.
 */

export const dynamic = 'force-dynamic';

const MEDIA_KEY_PATTERN =
  /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/w\d+\.[a-z0-9]+$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await context.params;

  if (!key || key.length === 0) {
    return new Response(null, { status: 404 });
  }

  const fullKey = key.join('/');

  // Reject internal keys like `original.bin` and keys outside the pattern.
  if (fullKey.includes('original.bin') || !MEDIA_KEY_PATTERN.test(fullKey)) {
    return new Response(null, { status: 404 });
  }

  const { storage } = container();

  const signedUrl = await storage.createSignedDownloadUrl(
    fullKey as StorageKey,
    3600, // 1 hour TTL; shorter than or equal to the signature lifetime
  );

  return new Response(null, {
    status: 302,
    headers: {
      location: signedUrl,
      'cache-control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}
