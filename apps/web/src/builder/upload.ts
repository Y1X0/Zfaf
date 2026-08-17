import { apiGet, apiSend } from '../auth/api.js';

/**
 * The browser's half of the three-stage upload (D4.2, docs/10 §4, docs/23 §7.3).
 *
 *   ① ask for a signed URL   → `POST /api/v1/media/upload-url`
 *   ② `PUT` straight to storage — **the file never touches our servers**
 *   ③ confirm                → `POST /api/v1/media/{id}/complete`
 *   ④ poll until the worker has written the derivatives
 *
 * Stage ② is the point of the shape. A 20 MB photo routed through the
 * application costs request time, memory and bandwidth for nothing; the object
 * store is better at receiving files than we will ever be. It also means the
 * headers the server bound into the signature must be sent back *exactly* —
 * both the content type and the length are part of what was signed, and an
 * upload that omits one is rejected by the bucket rather than by us.
 *
 * ## Why stage ④ exists
 *
 * `complete` returns as soon as storage confirms the object; the decoding,
 * re-encoding, EXIF stripping and derivative generation happen in
 * `apps/worker`. The document must carry a URL to a **derivative**, never to
 * the original — the original still holds whatever the camera wrote into it,
 * including, on most phones, the coordinates of the couple's home. So the
 * upload is not finished until the worker says it is.
 */

export type UploadStage = 'signing' | 'uploading' | 'confirming' | 'processing';

export interface UploadedImage {
  readonly id: string;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly blurhash: string | null;
}

export type UploadOutcome =
  | { readonly ok: true; readonly image: UploadedImage }
  | { readonly ok: false; readonly code: string };

interface SignedUploadResponse {
  readonly mediaId: string;
  readonly upload: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

interface MediaResponse {
  readonly status: string;
  readonly url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly blurhash: string | null;
}

/**
 * How long to wait for the worker.
 *
 * Generous, because the work is real — a HEIC from an iPhone is decoded,
 * re-encoded into three widths in three formats, and hashed. Bounded, because
 * a spinner with no end is worse than an error: at the limit the caller is
 * told the photo is still processing rather than left believing it failed.
 */
const POLL_INTERVAL_MS = 700;
const POLL_LIMIT_MS = 60_000;

export async function uploadImage(
  file: File,
  options: {
    readonly invitationId: string;
    readonly purpose: 'cover' | 'couple' | 'gallery' | 'ornament';
    readonly onStage?: (stage: UploadStage) => void;
    readonly signal?: AbortSignal;
  },
): Promise<UploadOutcome> {
  const stage = options.onStage ?? (() => {});

  stage('signing');
  const signed = await apiSend<SignedUploadResponse>('/api/v1/media/upload-url', 'POST', {
    invitationId: options.invitationId,
    purpose: options.purpose,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  });
  if (!signed.ok) return { ok: false, code: signed.error.code };

  stage('uploading');
  try {
    const response = await fetch(signed.data.upload.url, {
      method: signed.data.upload.method,
      /**
       * The signed headers, sent back unchanged.
       *
       * `Content-Type` and `Content-Length` are bound into the signature —
       * without the length bound, a URL issued for a 4 MB photo would accept a
       * 5 GB object. Rebuilding them here rather than echoing them is how the
       * two drift and every upload starts failing with an opaque 403.
       */
      headers: signed.data.upload.headers,
      body: file,
      // No credentials: this request goes to the object store, which
      // authenticates by signature. Sending our cookie to a third-party
      // hostname is exactly what we do not want.
      credentials: 'omit',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return { ok: false, code: 'UPLOAD_REJECTED' };
  } catch {
    return { ok: false, code: 'NETWORK' };
  }

  stage('confirming');
  const confirmed = await apiSend(`/api/v1/media/${signed.data.mediaId}/complete`, 'POST');
  if (!confirmed.ok) return { ok: false, code: confirmed.error.code };

  stage('processing');
  return pollUntilReady(signed.data.mediaId, options.signal);
}

async function pollUntilReady(mediaId: string, signal?: AbortSignal): Promise<UploadOutcome> {
  const deadline = Date.now() + POLL_LIMIT_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, code: 'CANCELLED' };

    const media = await apiGet<MediaResponse>(`/api/v1/media/${mediaId}`);
    if (!media.ok) return { ok: false, code: media.error.code };

    if (media.data.status === 'ready' && media.data.url) {
      return {
        ok: true,
        image: {
          id: mediaId,
          url: media.data.url,
          width: media.data.width,
          height: media.data.height,
          blurhash: media.data.blurhash,
        },
      };
    }
    // Terminal, and told apart: a quarantined file failed the scan or the
    // re-encode, which is a different thing to say than "it is taking a while".
    if (media.data.status === 'quarantined') return { ok: false, code: 'QUARANTINED' };
    if (media.data.status === 'failed') return { ok: false, code: 'PROCESSING_FAILED' };

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { ok: false, code: 'STILL_PROCESSING' };
}
