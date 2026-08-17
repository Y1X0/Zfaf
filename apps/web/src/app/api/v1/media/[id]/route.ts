import { getEnv } from '@zfaf/config';
import { deleteMedia, tenantScopeFor } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { requireActor } from '../../../../../server/request-context.js';
import { conflict, failure, notFound, ok, unauthorized } from '../../../../../server/responses.js';

/**
 * One media asset (D4.2, D4.7).
 *
 * `GET` is what the builder polls after `complete`: processing happens in
 * `apps/worker`, so the derivatives do not exist at the moment the upload
 * finishes and the interface has to be able to ask. `DELETE` removes it from
 * the owner's library.
 *
 * Both read through the tenant scope, so "not yours" and "does not exist" are
 * the same 404 — a media id is a UUID an attacker would otherwise be able to
 * confirm one guess at a time.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const scope = tenantScopeFor(session.actor);
  if (!scope) return unauthorized();

  const { id } = await context.params;
  const media = await container().media.findById(scope, id);
  if (!media || media.deletedAt !== null) return notFound('Media');

  const variants = publicVariants(media.variants);

  return ok({
    id: media.id,
    invitationId: media.invitationId,
    purpose: media.purpose,
    status: media.status,
    scanStatus: media.scanStatus,
    filename: media.originalFilename,
    sizeBytes: media.sizeBytes,
    width: media.width,
    height: media.height,
    blurhash: media.blurhash,
    variants,
    /**
     * What a document should carry for this asset, or null while it is still
     * being processed.
     *
     * The widest derivative, because the renderer picks a size from the
     * `variants` map and this is the fallback `src`. Deliberately **not** the
     * original: the original still holds whatever the camera wrote into it,
     * and only the derivatives have been re-encoded and stripped.
     */
    url: variants.length > 0 ? (variants[variants.length - 1]?.url ?? null) : null,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const { id } = await context.params;
  const deps = container();

  const result = await deleteMedia(
    { actor: session.actor, mediaId: id },
    { repository: deps.media, clock: deps.clock },
  );

  if (!result.ok) {
    switch (result.code) {
      case 'NOT_FOUND':
        return notFound('Media');
      case 'NO_TENANT_SCOPE':
        return unauthorized();
      case 'USED_IN_PUBLISHED_INVITATION':
      case 'ALREADY_DELETED':
        // Guests are looking at this photo right now (D4.7). A refusal the
        // owner can act on — unpublish, or publish a version without it.
        return conflict(result.code, result.message);
      default:
        return failure(403, 'FORBIDDEN', result.message);
    }
  }

  // Soft: the row is marked and the asset leaves the library immediately, the
  // bytes survive the grace period. "I deleted the wrong photo" is far more
  // frequent than a storage bill mattering.
  return ok({ deleted: true });
}

interface PublicVariant {
  readonly label: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Turns stored variant keys into addresses a browser can fetch.
 *
 * The key is internal; `STORAGE_PUBLIC_BASE_URL` is the bucket's public face
 * (the CDN in production, MinIO locally). Composed here rather than stored, so
 * moving the bucket behind a different hostname does not require rewriting
 * every media row — and, more to the point, does not leave old rows pointing
 * at the previous one.
 *
 * Sorted narrowest first, which is the order `srcset` wants and the order the
 * `url` fallback above depends on.
 */
function publicVariants(variants: Readonly<Record<string, unknown>>): readonly PublicVariant[] {
  const base = getEnv().STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '');
  const out: PublicVariant[] = [];

  for (const [label, value] of Object.entries(variants)) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const key = record['key'];
    const width = record['width'];
    const height = record['height'];
    if (typeof key !== 'string' || typeof width !== 'number' || typeof height !== 'number') {
      continue;
    }
    out.push({ label, url: `${base}/${key}`, width, height });
  }

  return out.sort((a, b) => a.width - b.width);
}
