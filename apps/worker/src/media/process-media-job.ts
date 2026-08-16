import type { StorageKey } from '@zfaf/shared';
import {
  type ImageProcessor,
  type MalwareScanner,
  type MediaProcessingRepository,
  type ProcessedVariant,
  type StorageProvider,
  isQuarantineFailure,
  storageExtensionFor,
} from '@zfaf/core';

/**
 * The media processing job (D4.3, D4.4).
 *
 * Failure handling is the substance of this file, and it distinguishes two
 * kinds of failure that a single `catch` would flatten into one:
 *
 *   • **Quarantine** — the file is not what it claims, or is hostile. The
 *     asset is marked terminally and the job reports success, because there is
 *     nothing to retry. A queue that retries a decompression bomb every few
 *     minutes has been turned into an attack amplifier.
 *   • **Failure** — the run went wrong: a network blip fetching the original,
 *     a worker restart mid-encode. The job throws so BullMQ retries it with
 *     backoff.
 *
 * Getting this the wrong way round is the difference between a bad upload
 * costing one job and costing a weekend.
 */

export interface ProcessMediaJobData {
  readonly mediaId: string;
}

export interface ProcessMediaDeps {
  readonly repository: MediaProcessingRepository;
  readonly storage: StorageProvider;
  readonly processor: ImageProcessor;
  readonly scanner: MalwareScanner;
}

export interface ProcessMediaOutcome {
  readonly mediaId: string;
  readonly result: 'ready' | 'quarantined' | 'skipped';
  readonly detail?: string;
  readonly variantsWritten?: number;
}

/**
 * A transient failure.
 *
 * Thrown rather than returned, because the queue's retry mechanism reacts to
 * exceptions. Every non-retryable outcome is a return value.
 */
export class TransientJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientJobError';
  }
}

export async function processMediaJob(
  data: ProcessMediaJobData,
  deps: ProcessMediaDeps,
): Promise<ProcessMediaOutcome> {
  const media = await deps.repository.loadForProcessing(data.mediaId);
  if (!media) {
    // The asset was deleted between enqueue and execution. Nothing to do, and
    // nothing wrong.
    return { mediaId: data.mediaId, result: 'skipped', detail: 'media no longer exists' };
  }

  if (media.status === 'ready') {
    // A duplicate delivery. Queues are at-least-once, so this is expected and
    // must not redo the work or overwrite the derivatives.
    return { mediaId: media.id, result: 'skipped', detail: 'already processed' };
  }
  if (media.status === 'quarantined') {
    return { mediaId: media.id, result: 'skipped', detail: 'quarantined' };
  }

  await deps.repository.markProcessing(media.id);

  let original: Uint8Array;
  try {
    const fetched = await fetchOriginal(deps.storage, media.storageKey);
    if (!fetched) {
      // The object should exist: `completeUpload` did a HEAD before queueing.
      // Its absence is a storage problem, so it is retried rather than treated
      // as a bad file.
      throw new TransientJobError(`original object missing for ${media.id}`);
    }
    original = fetched;
  } catch (error) {
    if (error instanceof TransientJobError) throw error;
    throw new TransientJobError(`could not read original: ${describe(error)}`);
  }

  const processed = await deps.processor.process(original, media.mimeType);

  if (!processed.ok) {
    if (isQuarantineFailure(processed.code)) {
      await deps.repository.quarantine(media.id, `${processed.code}: ${processed.reason}`);
      // The original stays in the bucket: it is evidence. The sweep removes it
      // on its own schedule.
      return { mediaId: media.id, result: 'quarantined', detail: processed.reason };
    }
    await deps.repository.markFailed(media.id, `${processed.code}: ${processed.reason}`);
    throw new TransientJobError(`${processed.code}: ${processed.reason}`);
  }

  const scan = await deps.scanner.scan(original);
  if (!scan.clean) {
    await deps.repository.quarantine(media.id, `malware: ${scan.threat ?? 'unspecified'}`);
    return { mediaId: media.id, result: 'quarantined', detail: scan.threat ?? 'malware detected' };
  }

  const variants: Record<string, unknown> = {};
  try {
    for (const variant of processed.image.variants) {
      const key = variantKey(media.storageKey, variant);
      await deps.storage.putObject(key, variant.bytes, contentTypeFor(variant.encoding));
      variants[`w${variant.width}.${variant.encoding}`] = {
        key,
        width: variant.width,
        height: variant.height,
        sizeBytes: variant.sizeBytes,
      };
    }
  } catch (error) {
    await deps.repository.markFailed(media.id, `variant upload: ${describe(error)}`);
    throw new TransientJobError(`variant upload failed: ${describe(error)}`);
  }

  await deps.repository.completeProcessing({
    mediaId: media.id,
    // The sniffed type replaces whatever the client claimed. From here on the
    // database holds a fact rather than an assertion.
    mimeType: `image/${processed.image.sourceFormat}`,
    sizeBytes: original.byteLength,
    width: processed.image.width,
    height: processed.image.height,
    blurhash: processed.image.blurhash,
    variants,
    // Honest about what happened: re-encoding is the defence, not a scan.
    scanStatus: deps.scanner.key === 'noop-reencode-only' ? 'skipped' : 'clean',
  });

  return {
    mediaId: media.id,
    result: 'ready',
    variantsWritten: processed.image.variants.length,
  };
}

/** Places a derivative beside its original, under the same media prefix. */
function variantKey(originalKey: StorageKey, variant: ProcessedVariant): StorageKey {
  const prefix = originalKey.slice(0, originalKey.lastIndexOf('/'));
  return `${prefix}/w${variant.width}.${storageExtensionFor(variant.encoding)}` as StorageKey;
}

function contentTypeFor(encoding: string): string {
  const table: Readonly<Record<string, string>> = {
    avif: 'image/avif',
    webp: 'image/webp',
    jpeg: 'image/jpeg',
  };
  return table[encoding] ?? 'application/octet-stream';
}

async function fetchOriginal(
  storage: StorageProvider,
  key: StorageKey,
): Promise<Uint8Array | null> {
  return storage.getObject(key);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
