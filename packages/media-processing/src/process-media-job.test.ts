import type { StorageKey } from '@zfaf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import {
  type ImageProcessor,
  type MalwareScanner,
  type MediaAssetRecord,
  type MediaProcessingRepository,
  NO_OP_SCANNER,
  type ProcessingResult,
  type ScanStatus,
  type StorageProvider,
} from '@zfaf/core';
import { InMemoryStorageProvider } from '@zfaf/infra';

import { SharpImageProcessor } from './sharp-image-processor.js';
import { TransientJobError, processMediaJob } from './process-media-job.js';

/**
 * Media job failure handling (D4.3).
 *
 * The distinction under test is the one that decides whether a hostile upload
 * costs one job or a weekend: a bad *file* is terminal and must not be
 * retried, while a bad *run* must be. Everything here is about which of those
 * two the handler picks.
 */

const MEDIA_ID = 'media-1';
const KEY = 'media/owner-1/inv-1/media-1/original.bin' as StorageKey;

function record(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  return {
    id: MEDIA_ID,
    ownerId: 'owner-1',
    invitationId: 'inv-1',
    purpose: 'gallery',
    storageKey: KEY,
    originalFilename: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    signedMaxBytes: 8 * 1024 * 1024,
    width: null,
    height: null,
    blurhash: null,
    variants: {},
    status: 'processing',
    scanStatus: 'pending',
    createdAt: new Date('2026-08-16T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

class FakeRepository implements MediaProcessingRepository {
  row: MediaAssetRecord | null = record();
  readonly calls: string[] = [];
  completed: Record<string, unknown> | null = null;
  quarantineReason: string | null = null;
  failureReason: string | null = null;

  async loadForProcessing(): Promise<MediaAssetRecord | null> {
    return this.row;
  }
  async markProcessing(): Promise<void> {
    this.calls.push('markProcessing');
  }
  async completeProcessing(input: {
    mediaId: string;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
    blurhash: string;
    variants: Readonly<Record<string, unknown>>;
    scanStatus: ScanStatus;
  }): Promise<void> {
    this.calls.push('completeProcessing');
    this.completed = { ...input };
  }
  async markFailed(_mediaId: string, reason: string): Promise<void> {
    this.calls.push('markFailed');
    this.failureReason = reason;
  }
  async quarantine(_mediaId: string, reason: string): Promise<void> {
    this.calls.push('quarantine');
    this.quarantineReason = reason;
  }
}

function processorReturning(result: ProcessingResult): ImageProcessor {
  return { process: async () => result };
}

async function realJpeg(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 40, g: 90, b: 140 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe('the happy path', () => {
  let repository: FakeRepository;
  let storage: InMemoryStorageProvider;

  beforeEach(async () => {
    repository = new FakeRepository();
    storage = new InMemoryStorageProvider();
    storage.seed(KEY, await realJpeg(), 'image/jpeg');
  });

  it('writes every derivative and records what the bytes actually were', async () => {
    const outcome = await processMediaJob(
      { mediaId: MEDIA_ID },
      {
        repository,
        storage,
        processor: new SharpImageProcessor(),
        scanner: NO_OP_SCANNER,
      },
    );

    expect(outcome.result).toBe('ready');
    expect(outcome.variantsWritten).toBeGreaterThan(0);

    // Derivatives land beside the original, under the same media prefix, so
    // the sweep can remove them all with one prefix delete.
    const written = storage.keys().filter((key) => key !== KEY);
    expect(written.length).toBe(outcome.variantsWritten);
    expect(written.every((key) => key.startsWith('media/owner-1/inv-1/media-1/'))).toBe(true);

    expect(repository.completed?.['mimeType']).toBe('image/jpeg');
    expect(repository.completed?.['width']).toBe(600);
    expect(repository.completed?.['blurhash']).toBeTruthy();
  });

  it('records the scan as skipped rather than clean when nothing scanned it', async () => {
    // Claiming a file was scanned when nothing scanned it is the kind of
    // untruth that gets believed during an incident.
    await processMediaJob(
      { mediaId: MEDIA_ID },
      { repository, storage, processor: new SharpImageProcessor(), scanner: NO_OP_SCANNER },
    );
    expect(repository.completed?.['scanStatus']).toBe('skipped');
  });

  it('records the size storage reported, not the row’s declared size', async () => {
    await processMediaJob(
      { mediaId: MEDIA_ID },
      { repository, storage, processor: new SharpImageProcessor(), scanner: NO_OP_SCANNER },
    );
    const actual = (await storage.getObject(KEY))?.byteLength;
    expect(repository.completed?.['sizeBytes']).toBe(actual);
    expect(repository.completed?.['sizeBytes']).not.toBe(1000);
  });
});

describe('a bad file is terminal, never retried', () => {
  let repository: FakeRepository;
  let storage: InMemoryStorageProvider;

  beforeEach(() => {
    repository = new FakeRepository();
    storage = new InMemoryStorageProvider();
    storage.seed(KEY, new Uint8Array(64), 'image/jpeg');
  });

  it.each([
    'QUARANTINE_REJECTED_FORMAT',
    'QUARANTINE_FORMAT_MISMATCH',
    'QUARANTINE_DIMENSIONS',
  ] as const)('quarantines on %s and returns rather than throwing', async (code) => {
    // Returning is the point. A throw becomes a retry, and a queue that
    // retries a decompression bomb has been turned into an amplifier.
    const outcome = await processMediaJob(
      { mediaId: MEDIA_ID },
      {
        repository,
        storage,
        processor: processorReturning({ ok: false, code, reason: 'nope' }),
        scanner: NO_OP_SCANNER,
      },
    );

    expect(outcome.result).toBe('quarantined');
    expect(repository.calls).toContain('quarantine');
    expect(repository.calls).not.toContain('markFailed');
  });

  it('keeps the original after quarantine, as evidence', async () => {
    await processMediaJob(
      { mediaId: MEDIA_ID },
      {
        repository,
        storage,
        processor: processorReturning({
          ok: false,
          code: 'QUARANTINE_REJECTED_FORMAT',
          reason: 'SVG',
        }),
        scanner: NO_OP_SCANNER,
      },
    );
    expect(await storage.getObject(KEY)).not.toBeNull();
  });

  it('quarantines when the scanner reports a threat', async () => {
    const scanner: MalwareScanner = {
      key: 'test-scanner',
      scan: async () => ({ clean: false, threat: 'EICAR-Test-File' }),
    };

    const outcome = await processMediaJob(
      { mediaId: MEDIA_ID },
      {
        repository,
        storage,
        processor: processorReturning({
          ok: true,
          image: { sourceFormat: 'jpeg', width: 10, height: 10, blurhash: 'x', variants: [] },
        }),
        scanner,
      },
    );

    expect(outcome.result).toBe('quarantined');
    expect(repository.quarantineReason).toContain('EICAR-Test-File');
    expect(repository.calls).not.toContain('completeProcessing');
  });
});

describe('a bad run is retried', () => {
  let repository: FakeRepository;

  beforeEach(() => {
    repository = new FakeRepository();
  });

  it('throws when the original cannot be read', async () => {
    // `completeUpload` did a HEAD before queueing, so an absent object is a
    // storage problem rather than a bad file.
    const storage = new InMemoryStorageProvider();
    await expect(
      processMediaJob(
        { mediaId: MEDIA_ID },
        {
          repository,
          storage,
          processor: new SharpImageProcessor(),
          scanner: NO_OP_SCANNER,
        },
      ),
    ).rejects.toBeInstanceOf(TransientJobError);
  });

  it.each(['FAILED_DECODE', 'FAILED_ENCODE'] as const)('throws on %s', async (code) => {
    const storage = new InMemoryStorageProvider();
    storage.seed(KEY, new Uint8Array(64), 'image/jpeg');

    await expect(
      processMediaJob(
        { mediaId: MEDIA_ID },
        {
          repository,
          storage,
          processor: processorReturning({ ok: false, code, reason: 'transient' }),
          scanner: NO_OP_SCANNER,
        },
      ),
    ).rejects.toBeInstanceOf(TransientJobError);

    expect(repository.calls).toContain('markFailed');
    expect(repository.calls).not.toContain('quarantine');
  });

  it('marks the asset failed when a derivative cannot be written', async () => {
    const storage = new InMemoryStorageProvider();
    storage.seed(KEY, await realJpeg(), 'image/jpeg');
    const broken: StorageProvider = {
      ...storage,
      key: storage.key,
      createUploadUrl: storage.createUploadUrl.bind(storage),
      createSignedDownloadUrl: storage.createSignedDownloadUrl.bind(storage),
      head: storage.head.bind(storage),
      getObject: storage.getObject.bind(storage),
      delete: storage.delete.bind(storage),
      deletePrefix: storage.deletePrefix.bind(storage),
      putObject: vi.fn(async () => {
        throw new Error('bucket unavailable');
      }),
    };

    await expect(
      processMediaJob(
        { mediaId: MEDIA_ID },
        {
          repository: repository,
          storage: broken,
          processor: new SharpImageProcessor(),
          scanner: NO_OP_SCANNER,
        },
      ),
    ).rejects.toBeInstanceOf(TransientJobError);

    expect(repository.failureReason).toContain('variant upload');
  });
});

describe('duplicate and stale deliveries', () => {
  it('does nothing when the asset no longer exists', async () => {
    const repository = new FakeRepository();
    repository.row = null;

    const outcome = await processMediaJob(
      { mediaId: MEDIA_ID },
      {
        repository,
        storage: new InMemoryStorageProvider(),
        processor: new SharpImageProcessor(),
        scanner: NO_OP_SCANNER,
      },
    );

    expect(outcome.result).toBe('skipped');
    expect(repository.calls).toEqual([]);
  });

  it.each(['ready', 'quarantined'] as const)(
    'skips an asset already in the %s state',
    async (status) => {
      // Queues deliver at least once. Reprocessing would overwrite
      // derivatives that a published invitation is already serving.
      const repository = new FakeRepository();
      repository.row = record({ status });

      const outcome = await processMediaJob(
        { mediaId: MEDIA_ID },
        {
          repository,
          storage: new InMemoryStorageProvider(),
          processor: new SharpImageProcessor(),
          scanner: NO_OP_SCANNER,
        },
      );

      expect(outcome.result).toBe('skipped');
      expect(repository.calls).toEqual([]);
    },
  );
});
