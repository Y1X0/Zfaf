import { getEnv } from '@zfaf/config';
import { completeUpload, tenantScopeFor } from '@zfaf/core';

import { container } from '../../../../../../server/container.js';
import { enqueueMediaProcessing } from '../../../../../../server/media-queue.js';
import { requireSameOrigin } from '../../../../../../server/origin.js';
import { requireActor } from '../../../../../../server/request-context.js';
import {
  conflict,
  failure,
  notFound,
  ok,
  unauthorized,
} from '../../../../../../server/responses.js';

/**
 * Stage ③ of the upload (D4.2, docs/10 §4).
 *
 * The client says "I have finished the PUT". Everything recorded from here is
 * read from the object store, not from that claim: the browser is not asked how
 * large the file is or what type it is, because it can prove neither and every
 * answer it could give is one an attacker chooses.
 *
 * On success the asset moves to `processing` and a job is queued for
 * `apps/worker`, which decodes the bytes, identifies the real type, generates
 * the derivatives and writes them back to storage. The row is marked *before*
 * the job is queued — a worker that arrived first would find a `pending` row
 * and refuse its own work.
 *
 * There is no body. The media id is in the path, the truth is in storage, and
 * anything else a client could send here would only be something to distrust.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const scope = tenantScopeFor(session.actor);
  if (!scope) return unauthorized();

  const { id } = await context.params;
  const deps = container();

  /**
   * The invitation's owner, loaded rather than accepted.
   *
   * `completeUpload` re-runs the authorization decision and needs the owner of
   * the invitation the asset is attached to. It is read here through the
   * tenant scope — a media row is found only inside the caller's own scope, so
   * a stranger's id is `NOT_FOUND` before this line is reached.
   */
  const media = await deps.media.findById(scope, id);
  if (!media) return notFound('Media');

  const invitation = media.invitationId
    ? await deps.invitations.findByIdInScope(media.invitationId, scope)
    : null;

  const redisUrl = getEnv().REDIS_URL;
  const result = await completeUpload(
    {
      actor: session.actor,
      mediaId: id,
      invitationOwnerId: invitation?.ownerId ?? null,
    },
    {
      repository: deps.media,
      storage: deps.storage,
      enqueue: (job) => enqueueMediaProcessing(redisUrl, job.mediaId),
    },
  );

  if (!result.ok) {
    switch (result.code) {
      case 'NOT_FOUND':
        return notFound('Media');
      case 'NO_TENANT_SCOPE':
        return unauthorized();
      case 'INVALID_STATE':
        // Already processing, already ready, or quarantined. A second
        // `complete` for one upload is a duplicate, not a failure to explain
        // away — but it is also not a success, so it says so.
        return conflict('INVALID_STATE', result.message);
      case 'OBJECT_MISSING':
        return conflict('OBJECT_MISSING', result.message);
      case 'SIZE_MISMATCH':
        // The signature should have prevented this; reaching it means the
        // provider did not honour the bound. The asset is already quarantined.
        return conflict('SIZE_MISMATCH', result.message);
      default:
        return failure(403, 'FORBIDDEN', result.message);
    }
  }

  return ok({
    mediaId: result.mediaId,
    sizeBytes: result.sizeBytes,
    // `processing`, always. The derivatives do not exist yet, and telling the
    // client otherwise is how a gallery ends up rendering a missing image.
    status: 'processing',
  });
}
