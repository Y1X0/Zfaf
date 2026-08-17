import { getEnv } from '@zfaf/config';
import { UPLOAD_PURPOSES, type UploadPurpose, requestUploadUrl, tenantScopeFor } from '@zfaf/core';

import { container } from '../../../../../server/container.js';
import { entitlementsFor } from '../../../../../server/entitlements.js';
import { requireSameOrigin } from '../../../../../server/origin.js';
import { requireActor } from '../../../../../server/request-context.js';
import {
  badRequest,
  conflict,
  created,
  failure,
  forbidden,
  notFound,
  rateLimited,
  readJsonBody,
  unauthorized,
} from '../../../../../server/responses.js';

/**
 * Stage ① of the upload (D4.2, docs/10 §4).
 *
 * Answers with a URL the browser `PUT`s the file to **directly**. Our servers
 * never see the bytes: a 20 MB photo through the application costs request
 * time, memory and bandwidth for nothing, and the object store is better at
 * receiving files than we will ever be.
 *
 * The URL is narrow by construction — one key, one content type, one size
 * ceiling, fifteen minutes — because a signature that bounds only the key
 * accepts a 5 GB object against a request for a 4 MB photo.
 *
 * The **invitation's owner is loaded here and never taken from the body.** The
 * use case needs it for the authorization decision and says so in its input
 * type; a client-supplied owner id would let anyone name themselves the owner
 * of somebody else's invitation and upload into it.
 */
export async function POST(request: Request): Promise<Response> {
  // Layer 2 of the CSRF defence (docs/09 §5). `SameSite=Lax` is layer 1.
  const crossSite = requireSameOrigin(request);
  if (crossSite) return crossSite;

  const session = await requireActor();
  if (!session.authenticated) return unauthorized();

  const scope = tenantScopeFor(session.actor);
  if (!scope) return unauthorized();

  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return body.response;

  const payload =
    body.body !== null && typeof body.body === 'object' && !Array.isArray(body.body)
      ? (body.body as Record<string, unknown>)
      : {};

  const invitationId = payload['invitationId'];
  if (typeof invitationId !== 'string' || invitationId.length === 0) {
    return badRequest('INVALID_INVITATION', 'invitationId is required');
  }
  const purpose = payload['purpose'];
  if (typeof purpose !== 'string' || !(UPLOAD_PURPOSES as readonly string[]).includes(purpose)) {
    return badRequest('INVALID_PURPOSE', `purpose must be one of ${UPLOAD_PURPOSES.join(', ')}`);
  }
  const filename = payload['filename'];
  if (typeof filename !== 'string' || filename.length === 0) {
    return badRequest('INVALID_FILENAME', 'filename is required');
  }
  const contentType = payload['contentType'];
  if (typeof contentType !== 'string' || contentType.length === 0) {
    return badRequest('INVALID_CONTENT_TYPE', 'contentType is required');
  }
  const declaredSizeBytes = payload['sizeBytes'];
  if (typeof declaredSizeBytes !== 'number' || !Number.isInteger(declaredSizeBytes)) {
    return badRequest('INVALID_SIZE', 'sizeBytes must be an integer');
  }

  const deps = container();
  const userId = session.actor.kind === 'user' ? session.actor.userId : null;
  if (userId === null) return forbidden('Not permitted to upload here');

  // Scoped read: "not yours" and "does not exist" answer identically, so this
  // endpoint cannot be used to discover other owners' invitation ids.
  const invitation = await deps.invitations.findByIdInScope(invitationId, scope);
  if (!invitation) return notFound('Invitation');

  const result = await requestUploadUrl(
    {
      actor: session.actor,
      invitationId: invitation.id,
      invitationOwnerId: invitation.ownerId,
      purpose: purpose as UploadPurpose,
      filename,
      contentType,
      declaredSizeBytes,
      ipHash: session.ipHash,
    },
    {
      repository: deps.media,
      storage: deps.storage,
      entitlements: await entitlementsFor(userId),
      ids: deps.ids,
      clock: deps.clock,
      rateLimiter: deps.rateLimiter,
    },
  );

  if (!result.ok) {
    switch (result.code) {
      case 'RATE_LIMITED':
        return rateLimited(60);
      case 'UNSUPPORTED_TYPE':
      case 'INVALID_SIZE':
      case 'FILE_TOO_LARGE':
        return badRequest(result.code, result.message);
      case 'GALLERY_LIMIT_REACHED':
      case 'STORAGE_QUOTA_EXCEEDED':
        // A plan ceiling, not a permission problem — and one the owner can
        // clear themselves by deleting something.
        return conflict(result.code, result.message);
      case 'NO_TENANT_SCOPE':
        return unauthorized();
      default:
        // Everything else out of `can()` is an authorization refusal.
        return failure(403, 'FORBIDDEN', result.message);
    }
  }

  return created({
    mediaId: result.mediaId,
    upload: {
      url: result.upload.url,
      method: result.upload.method,
      headers: result.upload.requiredHeaders,
      expiresAt: result.upload.expiresAt.toISOString(),
    },
    // Echoed so the client can show the ceiling it is actually bound by
    // rather than one it computed from a plan name (ADR-0014).
    maxSizeBytes: Number(result.upload.requiredHeaders['Content-Length'] ?? 0),
    // The bucket is addressed by the browser, so a misconfigured endpoint
    // shows up here rather than as a silent CORS failure in the console.
    storageDriver: getEnv().STORAGE_DRIVER,
  });
}
