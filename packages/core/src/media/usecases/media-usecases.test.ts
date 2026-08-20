import type { StorageKey } from '@zfaf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Actor } from '../../authz/actor.js';
import type { TenantScope } from '../../authz/tenant-scope.js';
import { resolveEntitlements } from '../../billing/domain/entitlements.js';
import { fixedClock } from '../../ports/clock.js';
import type { IdGenerator } from '../../ports/id-generator.js';
import type { RateLimiter } from '../../identity/ports/rate-limiter.js';
import type { MediaUsage } from '../domain/media-deletion.js';
import type { MediaStatus } from '../domain/media-status.js';
import type {
  CreatePendingMediaInput,
  MediaAssetRecord,
  MediaMaintenanceRepository,
  MediaRepository,
} from '../ports/media-repository.js';
import type {
  CreateUploadUrlInput,
  ObjectMetadata,
  SignedUpload,
  StorageProvider,
} from '../ports/storage-provider.js';
import { completeUpload, requestUploadUrl } from './upload-media.js';
import { deleteMedia, redriveStuckMedia, sweepMedia } from './manage-media.js';

/**
 * The upload, deletion and sweep use cases.
 *
 * Driven through fakes rather than mocks that assert on calls: what matters is
 * the *decision* each use case reaches, not the sequence of methods it happened
 * to invoke on the way. A test that pins the call order breaks on every
 * refactor and catches none of the bugs that matter.
 */

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const INVITATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-16T12:00:00Z');

function user(overrides: Partial<Extract<Actor, { kind: 'user' }>> = {}): Actor {
  return {
    kind: 'user',
    userId: OWNER_ID,
    role: 'customer',
    emailVerified: true,
    status: 'active',
    sessionId: 'session-1',
    memberships: [{ invitationId: INVITATION_ID, role: 'owner' }],
    ...overrides,
  } as Actor;
}

function entitlements(overrides: Record<string, number> = {}) {
  return resolveEntitlements(
    {
      key: 'test_plan',
      level: 1,
      limits: {
        features: [],
        limits: {
          'media.image_size_mb': 8,
          'media.storage_mb': 100,
          'media.gallery_images': 10,
          ...overrides,
        } as never,
      },
    },
    [],
    NOW,
  );
}

// ── fakes ──────────────────────────────────────────────────────────────────

class FakeMediaRepository implements MediaRepository {
  readonly rows = new Map<string, MediaAssetRecord>();
  usageByMedia = new Map<string, MediaUsage>();
  storageUsed = 0;
  galleryCount = 0;

  async create(_scope: TenantScope, input: CreatePendingMediaInput): Promise<MediaAssetRecord> {
    const record: MediaAssetRecord = {
      id: input.id,
      ownerId: input.ownerId,
      invitationId: input.invitationId,
      purpose: input.purpose,
      storageKey: input.storageKey,
      originalFilename: input.originalFilename,
      mimeType: input.declaredMimeType,
      sizeBytes: input.declaredSizeBytes,
      signedMaxBytes: input.signedMaxBytes,
      width: null,
      height: null,
      blurhash: null,
      variants: {},
      status: 'pending',
      scanStatus: 'pending',
      createdAt: NOW,
      deletedAt: null,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async findById(_scope: TenantScope, mediaId: string): Promise<MediaAssetRecord | null> {
    return this.rows.get(mediaId) ?? null;
  }

  async storageUsedBytes(): Promise<number> {
    return this.storageUsed;
  }

  async countByPurpose(): Promise<number> {
    return this.galleryCount;
  }

  async usage(_scope: TenantScope, mediaId: string): Promise<MediaUsage> {
    return this.usageByMedia.get(mediaId) ?? { publishedVersionIds: [], draftReferenceCount: 0 };
  }

  async markStatus(_scope: TenantScope, mediaId: string, status: MediaStatus): Promise<void> {
    const row = this.rows.get(mediaId);
    if (row) this.rows.set(mediaId, { ...row, status });
  }

  async softDelete(_scope: TenantScope, mediaId: string, deletedAt: Date): Promise<void> {
    const row = this.rows.get(mediaId);
    if (row) this.rows.set(mediaId, { ...row, deletedAt });
  }
}

class FakeStorage implements StorageProvider {
  readonly key = 'fake';
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  lastUpload: CreateUploadUrlInput | null = null;
  deleted: string[] = [];
  deletedPrefixes: string[] = [];

  async createUploadUrl(input: CreateUploadUrlInput): Promise<SignedUpload> {
    this.lastUpload = input;
    return {
      url: `https://storage.test/${input.key}?sig=x`,
      method: 'PUT',
      requiredHeaders: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.maxSizeBytes),
      },
      expiresAt: new Date(NOW.getTime() + input.expiresInSeconds * 1000),
    };
  }

  async createSignedDownloadUrl(key: StorageKey): Promise<string> {
    return `https://storage.test/${key}`;
  }

  async head(key: StorageKey): Promise<ObjectMetadata | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      sizeBytes: object.bytes.byteLength,
      contentType: object.contentType,
      etag: 'etag',
      lastModified: NOW,
    };
  }

  async getObject(key: StorageKey): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async putObject(key: StorageKey, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }

  async delete(key: StorageKey): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.deletedPrefixes.push(prefix);
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        count += 1;
      }
    }
    return count;
  }
}

function allowingRateLimiter(): RateLimiter {
  return {
    consume: async () => ({ allowed: true, remaining: 59, resetAt: NOW }),
    reset: async () => undefined,
    peek: async () => ({ allowed: true, remaining: 59, resetAt: NOW }),
  };
}

function sequentialIds(): IdGenerator {
  let counter = 0;
  return {
    uuid: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
    token: () => 'token',
  };
}

// ── stage ① ────────────────────────────────────────────────────────────────

describe('requesting an upload URL', () => {
  let repository: FakeMediaRepository;
  let storage: FakeStorage;

  const deps = () => ({
    repository,
    storage,
    entitlements: entitlements(),
    ids: sequentialIds(),
    clock: fixedClock(NOW),
    rateLimiter: allowingRateLimiter(),
  });

  const input = (overrides: Record<string, unknown> = {}) => ({
    actor: user(),
    invitationId: INVITATION_ID,
    invitationOwnerId: OWNER_ID,
    purpose: 'gallery' as const,
    filename: 'IMG_0421.HEIC',
    contentType: 'image/heic',
    declaredSizeBytes: 3_000_000,
    ipHash: 'ip-hash',
    ...overrides,
  });

  beforeEach(() => {
    repository = new FakeMediaRepository();
    storage = new FakeStorage();
  });

  it('signs a URL bound to the key, type and size', async () => {
    const result = await requestUploadUrl(input(), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(storage.lastUpload?.contentType).toBe('image/heic');
    // Signed to the declared file size, not the plan limit. The browser will send
    // the actual size in Content-Length (forbidden header, calculated by fetch),
    // and it must match the signature (docs/25 §1).
    expect(storage.lastUpload?.maxSizeBytes).toBe(3_000_000);
    expect(storage.lastUpload?.expiresInSeconds).toBe(900);
    expect(result.upload.method).toBe('PUT');
  });

  it('composes the key from server identifiers, never from the filename', () => {
    // The filename is a path traversal vector; it lives in the database for
    // display and nowhere else (docs/10 §3).
    return requestUploadUrl(input({ filename: '../../../etc/passwd' }), deps()).then((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.storageKey).not.toContain('passwd');
      expect(result.storageKey).not.toContain('..');
      expect(result.storageKey).toContain(OWNER_ID);
    });
  });

  it('records the sanitised filename for display', async () => {
    const result = await requestUploadUrl(input({ filename: '../../evil/photo.jpg' }), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(repository.rows.get(result.mediaId)?.originalFilename).toBe('photo.jpg');
  });

  it('creates the row as pending, not ready', async () => {
    const result = await requestUploadUrl(input(), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(repository.rows.get(result.mediaId)?.status).toBe('pending');
  });

  it('refuses an actor with no membership on the invitation', async () => {
    const result = await requestUploadUrl(
      input({ actor: user({ userId: OTHER_ID, memberships: [] }), invitationOwnerId: OWNER_ID }),
      deps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_A_MEMBER');
    // Nothing was signed and nothing was written.
    expect(storage.lastUpload).toBeNull();
    expect(repository.rows.size).toBe(0);
  });

  it('refuses a viewer, who may read but not upload', async () => {
    const result = await requestUploadUrl(
      input({
        actor: user({
          userId: OTHER_ID,
          memberships: [{ invitationId: INVITATION_ID, role: 'viewer' }],
        }),
      }),
      deps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INSUFFICIENT_MEMBERSHIP_ROLE');
  });

  it('refuses a suspended account', async () => {
    const result = await requestUploadUrl(input({ actor: user({ status: 'suspended' }) }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('refuses an unsupported type before signing anything', async () => {
    const result = await requestUploadUrl(input({ contentType: 'image/svg+xml' }), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNSUPPORTED_TYPE');
    expect(storage.lastUpload).toBeNull();
  });

  it('refuses when the storage quota is exhausted', async () => {
    repository.storageUsed = 99 * 1024 * 1024;
    const result = await requestUploadUrl(input(), deps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('STORAGE_QUOTA_EXCEEDED');
  });

  it('refuses when rate limited, without signing', async () => {
    const limiter: RateLimiter = {
      consume: async () => ({ allowed: false, remaining: 0, resetAt: NOW, retryAfterSeconds: 60 }),
      reset: async () => undefined,
      peek: async () => ({ allowed: false, remaining: 0, resetAt: NOW }),
    };
    const result = await requestUploadUrl(input(), { ...deps(), rateLimiter: limiter });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('RATE_LIMITED');
    expect(storage.lastUpload).toBeNull();
  });
});

// ── stage ③ ────────────────────────────────────────────────────────────────

describe('completing an upload', () => {
  let repository: FakeMediaRepository;
  let storage: FakeStorage;
  let enqueue: ReturnType<typeof vi.fn>;

  async function seedPendingUpload(sizeBytes = 3_000_000): Promise<string> {
    const result = await requestUploadUrl(
      {
        actor: user(),
        invitationId: INVITATION_ID,
        invitationOwnerId: OWNER_ID,
        purpose: 'gallery',
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        declaredSizeBytes: sizeBytes,
        ipHash: 'ip',
      },
      {
        repository,
        storage,
        entitlements: entitlements(),
        ids: sequentialIds(),
        clock: fixedClock(NOW),
        rateLimiter: allowingRateLimiter(),
      },
    );
    if (!result.ok) throw new Error('seed failed');
    return result.mediaId;
  }

  beforeEach(() => {
    repository = new FakeMediaRepository();
    storage = new FakeStorage();
    enqueue = vi.fn(async () => undefined);
  });

  it('reads the size from storage and queues processing', async () => {
    const mediaId = await seedPendingUpload();
    const key = repository.rows.get(mediaId)?.storageKey as StorageKey;
    await storage.putObject(key, new Uint8Array(2_500_000), 'image/jpeg');

    const result = await completeUpload(
      { actor: user(), mediaId, invitationOwnerId: OWNER_ID },
      { repository, storage, enqueue },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The number came from storage, not from the client's 3,000,000 claim.
    expect(result.sizeBytes).toBe(2_500_000);
    expect(enqueue).toHaveBeenCalledWith({ mediaId });
    expect(repository.rows.get(mediaId)?.status).toBe('processing');
  });

  it('refuses when the object never arrived, and queues nothing', async () => {
    const mediaId = await seedPendingUpload();
    const result = await completeUpload(
      { actor: user(), mediaId, invitationOwnerId: OWNER_ID },
      { repository, storage, enqueue },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('OBJECT_MISSING');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('quarantines an object larger than the signature allowed', async () => {
    // Unreachable if the provider honours the bound — which is why it is
    // checked. A provider that does not would otherwise be invisible.
    const mediaId = await seedPendingUpload();
    const key = repository.rows.get(mediaId)?.storageKey as StorageKey;
    await storage.putObject(key, new Uint8Array(9 * 1024 * 1024), 'image/jpeg');

    const result = await completeUpload(
      { actor: user(), mediaId, invitationOwnerId: OWNER_ID },
      { repository, storage, enqueue },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIZE_MISMATCH');
    expect(repository.rows.get(mediaId)?.status).toBe('quarantined');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not reveal whether another owner’s media id exists', async () => {
    // Same answer for "no such media" and "not yours", so the endpoint is not
    // an existence oracle.
    const result = await completeUpload(
      { actor: user(), mediaId: 'someone-elses-id', invitationOwnerId: OWNER_ID },
      { repository, storage, enqueue },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe('Media not found');
  });

  it('refuses to re-complete an asset that is already processing', async () => {
    const mediaId = await seedPendingUpload();
    const key = repository.rows.get(mediaId)?.storageKey as StorageKey;
    await storage.putObject(key, new Uint8Array(1000), 'image/jpeg');
    await repository.markStatus({} as TenantScope, mediaId, 'ready');

    const result = await completeUpload(
      { actor: user(), mediaId, invitationOwnerId: OWNER_ID },
      { repository, storage, enqueue },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_STATE');
  });
});

// ── deletion ───────────────────────────────────────────────────────────────

describe('deleting media', () => {
  let repository: FakeMediaRepository;

  async function seedReadyAsset(id = 'media-1'): Promise<void> {
    await repository.create({} as TenantScope, {
      id,
      ownerId: OWNER_ID,
      invitationId: INVITATION_ID,
      purpose: 'gallery',
      storageKey: `media/${OWNER_ID}/${INVITATION_ID}/${id}/original.jpg` as StorageKey,
      originalFilename: 'photo.jpg',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
      signedMaxBytes: 8 * 1024 * 1024,
    });
  }

  beforeEach(() => {
    repository = new FakeMediaRepository();
  });

  it('soft-deletes an unreferenced asset', async () => {
    await seedReadyAsset();
    const result = await deleteMedia(
      { actor: user(), mediaId: 'media-1' },
      { repository, clock: fixedClock(NOW) },
    );

    expect(result.ok).toBe(true);
    // Soft: the bytes survive the grace period, because "I deleted the wrong
    // photo" is far more common than a storage bill mattering.
    expect(repository.rows.get('media-1')?.deletedAt).toEqual(NOW);
  });

  it('refuses to delete an asset a published invitation uses', async () => {
    await seedReadyAsset();
    repository.usageByMedia.set('media-1', {
      publishedVersionIds: ['version-7'],
      draftReferenceCount: 0,
    });

    const result = await deleteMedia(
      { actor: user(), mediaId: 'media-1' },
      { repository, clock: fixedClock(NOW) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('USED_IN_PUBLISHED_INVITATION');
    expect(repository.rows.get('media-1')?.deletedAt).toBeNull();
  });

  it('allows deletion when only a draft references it', async () => {
    await seedReadyAsset();
    repository.usageByMedia.set('media-1', {
      publishedVersionIds: [],
      draftReferenceCount: 4,
    });

    const result = await deleteMedia(
      { actor: user(), mediaId: 'media-1' },
      { repository, clock: fixedClock(NOW) },
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a viewer', async () => {
    await seedReadyAsset();
    const result = await deleteMedia(
      {
        actor: user({
          userId: OTHER_ID,
          memberships: [{ invitationId: INVITATION_ID, role: 'viewer' }],
        }),
        mediaId: 'media-1',
      },
      { repository, clock: fixedClock(NOW) },
    );
    expect(result.ok).toBe(false);
  });
});

// ── the sweep ──────────────────────────────────────────────────────────────

describe('sweeping abandoned and expired media', () => {
  function asset(id: string, overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
    return {
      id,
      ownerId: OWNER_ID,
      invitationId: INVITATION_ID,
      purpose: 'gallery',
      storageKey: `media/${OWNER_ID}/${INVITATION_ID}/${id}/original.jpg` as StorageKey,
      originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
      signedMaxBytes: 8 * 1024 * 1024,
      width: null,
      height: null,
      blurhash: null,
      variants: {},
      status: 'pending',
      scanStatus: 'pending',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      deletedAt: null,
      ...overrides,
    };
  }

  class FakeMaintenance implements MediaMaintenanceRepository {
    stale: MediaAssetRecord[] = [];
    purgeable: MediaAssetRecord[] = [];
    stuck: MediaAssetRecord[] = [];
    hardDeleted: string[] = [];
    /** What cutoff the redrive asked for, so the window can be asserted. */
    stuckBefore: Date | null = null;

    async findStalePendingUploads(): Promise<readonly MediaAssetRecord[]> {
      return this.stale;
    }
    async findPurgeableAssets(): Promise<readonly MediaAssetRecord[]> {
      return this.purgeable;
    }
    async findStuckProcessing(updatedBefore: Date): Promise<readonly MediaAssetRecord[]> {
      this.stuckBefore = updatedBefore;
      return this.stuck;
    }
    async hardDelete(mediaId: string): Promise<void> {
      this.hardDeleted.push(mediaId);
    }
  }

  it('removes abandoned uploads and reports what it did', async () => {
    const repository = new FakeMaintenance();
    repository.stale = [asset('stale-1'), asset('stale-2')];
    const storage = new FakeStorage();

    const report = await sweepMedia({ repository, storage, clock: fixedClock(NOW) });

    expect(report.stalePendingRemoved).toBe(2);
    expect(repository.hardDeleted).toEqual(['stale-1', 'stale-2']);
    expect(storage.deleted).toHaveLength(2);
    expect(report.failures).toEqual([]);
  });

  it('removes a purged asset’s whole prefix, not just its original', async () => {
    // Derivatives share the prefix, so one call removes the original and every
    // encoding without the sweep needing to know which were produced.
    const repository = new FakeMaintenance();
    repository.purgeable = [asset('gone-1', { deletedAt: new Date('2026-08-01T00:00:00Z') })];
    const storage = new FakeStorage();
    for (const name of ['original.jpg', 'w400.avif', 'w1080.webp']) {
      await storage.putObject(
        `media/${OWNER_ID}/${INVITATION_ID}/gone-1/${name}` as StorageKey,
        new Uint8Array([1]),
        'image/avif',
      );
    }

    const report = await sweepMedia({ repository, storage, clock: fixedClock(NOW) });

    expect(report.purgedAssets).toBe(1);
    expect(report.storageObjectsDeleted).toBe(3);
    expect(storage.objects.size).toBe(0);
  });

  it('records a failure and keeps going rather than aborting the run', async () => {
    // One unreachable object must not stop the sweep from cleaning the rest.
    const repository = new FakeMaintenance();
    repository.stale = [asset('bad'), asset('good')];
    const storage = new FakeStorage();
    const original = storage.delete.bind(storage);
    storage.delete = async (key: StorageKey) => {
      if (key.includes('bad')) throw new Error('storage unavailable');
      return original(key);
    };

    const report = await sweepMedia({ repository, storage, clock: fixedClock(NOW) });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('bad');
    expect(repository.hardDeleted).toEqual(['good']);
  });

  it('empties storage before dropping the row', async () => {
    // The reverse order loses the only pointer to the object and leaves bytes
    // nobody can find or bill.
    const repository = new FakeMaintenance();
    repository.stale = [asset('ordered')];
    const storage = new FakeStorage();
    const order: string[] = [];

    const originalDelete = storage.delete.bind(storage);
    storage.delete = async (key: StorageKey) => {
      order.push('storage');
      return originalDelete(key);
    };
    const originalHardDelete = repository.hardDelete.bind(repository);
    repository.hardDelete = async (id: string) => {
      order.push('row');
      return originalHardDelete(id);
    };

    await sweepMedia({ repository, storage, clock: fixedClock(NOW) });
    expect(order).toEqual(['storage', 'row']);
  });

  /**
   * The redrive (ADR-0023).
   *
   * These are the tests that make `MEDIA_DISPATCH=inline` a supported
   * deployment rather than a way to lose photographs. The `inline` adapter has
   * no retry — the process that was encoding simply went away — so everything
   * BullMQ's backoff used to guarantee has to be reconstructed here, and
   * anything not asserted below is a guarantee nobody is making.
   */
  describe('redriving stuck uploads', () => {
    it('dispatches every asset the query returned, and counts them', async () => {
      const repository = new FakeMaintenance();
      repository.stuck = [asset('stuck-1'), asset('stuck-2')];
      const dispatched: string[] = [];

      const report = await redriveStuckMedia({
        repository,
        clock: fixedClock(NOW),
        dispatch: async (id) => {
          dispatched.push(id);
        },
      });

      expect(dispatched).toEqual(['stuck-1', 'stuck-2']);
      expect(report.redriven).toBe(2);
      expect(report.failures).toEqual([]);
    });

    it('asks only for assets untouched for the full stuck window', async () => {
      const repository = new FakeMaintenance();

      await redriveStuckMedia({ repository, clock: fixedClock(NOW), dispatch: async () => {} });

      // Fifteen minutes before "now", to the millisecond. A window that
      // silently widened would redrive an encode that is merely slow, and two
      // runners writing the same derivatives is the failure this bounds.
      expect(repository.stuckBefore?.toISOString()).toBe(
        new Date(NOW.getTime() - 15 * 60 * 1000).toISOString(),
      );
    });

    it('keeps going when one asset fails, and reports which', async () => {
      const repository = new FakeMaintenance();
      repository.stuck = [asset('bad'), asset('good')];
      const dispatched: string[] = [];

      const report = await redriveStuckMedia({
        repository,
        clock: fixedClock(NOW),
        dispatch: async (id) => {
          if (id === 'bad') throw new Error('redis unreachable');
          dispatched.push(id);
        },
      });

      // The second asset is the point: a maintenance pass that abandons its
      // batch on the first error leaves every later asset stuck forever.
      expect(dispatched).toEqual(['good']);
      expect(report.redriven).toBe(1);
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0]).toContain('bad');
      expect(report.failures[0]).toContain('redis unreachable');
    });

    it('does nothing when nothing is stuck', async () => {
      const repository = new FakeMaintenance();
      let called = 0;

      const report = await redriveStuckMedia({
        repository,
        clock: fixedClock(NOW),
        dispatch: async () => {
          called += 1;
        },
      });

      expect(called).toBe(0);
      expect(report.redriven).toBe(0);
    });
  });
});
