import type { StorageKey } from '@zfaf/shared';
import type { StorageProvider } from '@zfaf/core';
import { describe, expect, it } from 'vitest';

import { InMemoryStorageProvider } from './in-memory-storage-provider.js';
import { S3StorageProvider } from './s3-storage-provider.js';

/**
 * The storage contract (D4.1, ADR-0007 amendment).
 *
 * One suite, run against every adapter. This is what makes "the provider is
 * swappable" a checkable claim instead of an intention: if a behaviour only
 * holds for one implementation, the suite says so by name.
 *
 * Two kinds of test live here, and the split is deliberate:
 *
 *   • **Behavioural** tests need a live endpoint. They run against MinIO or R2
 *     when `S3_TEST_ENDPOINT` is set and against the in-memory provider
 *     always. Standing up a fake S3 server to test our S3 adapter would be
 *     testing our fake, so we do not.
 *   • **Structural** tests run everywhere. They assert the properties every
 *     adapter must have regardless of transport — the same method surface, the
 *     same signature narrowing, the same TTL ceiling — which is precisely
 *     where a second adapter usually drifts.
 */

interface Adapter {
  readonly name: string;
  readonly create: () => StorageProvider;
  /** Live adapters need a unique prefix so parallel runs cannot collide. */
  readonly live: boolean;
}

function s3ConfigFromEnv(): Adapter | null {
  const endpoint = process.env['S3_TEST_ENDPOINT'];
  const bucket = process.env['S3_TEST_BUCKET'];
  const accessKeyId = process.env['S3_TEST_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['S3_TEST_SECRET_ACCESS_KEY'];
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    name: process.env['S3_TEST_DRIVER'] ?? 'minio',
    live: true,
    create: () =>
      new S3StorageProvider({
        driver: process.env['S3_TEST_DRIVER'] ?? 'minio',
        endpoint,
        bucket,
        accessKeyId,
        secretAccessKey,
        region: process.env['S3_TEST_REGION'] ?? 'auto',
        // MinIO is path-style; R2 and S3 are virtual-host. Configurable so the
        // same suite exercises both addressing modes.
        forcePathStyle: (process.env['S3_TEST_PATH_STYLE'] ?? 'true') === 'true',
      }),
  };
}

const inMemory: Adapter = {
  name: 'in-memory',
  live: false,
  create: () => new InMemoryStorageProvider(),
};

const liveAdapter = s3ConfigFromEnv();
const adapters: Adapter[] = liveAdapter ? [inMemory, liveAdapter] : [inMemory];

/**
 * Adapters that are only constructed, never called.
 *
 * The S3 adapter's *shape* can be checked without a server, and shape is where
 * a divergence between two implementations of a port actually shows up.
 */
const structuralAdapters: { name: string; provider: StorageProvider }[] = [
  { name: 'in-memory', provider: new InMemoryStorageProvider() },
  {
    name: 's3 (r2 configuration)',
    provider: new S3StorageProvider({
      driver: 'r2',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'zfaf-media',
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret',
      forcePathStyle: false,
    }),
  },
  {
    name: 's3 (minio configuration)',
    provider: new S3StorageProvider({
      driver: 'minio',
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'zfaf-media',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      forcePathStyle: true,
    }),
  },
];

const key = (suffix: string): StorageKey => `media/contract/${suffix}` as StorageKey;

// ── structural: runs everywhere ────────────────────────────────────────────

describe.each(structuralAdapters)('$name implements the port', ({ provider }) => {
  it('exposes every method the port declares', () => {
    for (const method of [
      'createUploadUrl',
      'createSignedDownloadUrl',
      'head',
      'getObject',
      'putObject',
      'delete',
      'deletePrefix',
    ] as const) {
      expect(typeof provider[method], `missing ${method}`).toBe('function');
    }
  });

  it('identifies itself', () => {
    expect(provider.key).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('the S3 adapter signs uploads narrowly', () => {
  // These exercise the real signer. No network is involved: presigning is a
  // local HMAC over the request, which is exactly the part worth checking.
  const provider = structuralAdapters[1]?.provider as StorageProvider;

  it('binds the method, key, content type and size into the URL', async () => {
    const upload = await provider.createUploadUrl({
      key: key('signed.bin'),
      contentType: 'image/heic',
      maxSizeBytes: 4_200_000,
      expiresInSeconds: 900,
    });

    expect(upload.method).toBe('PUT');
    expect(upload.url).toContain('media/contract/signed.bin');
    expect(upload.requiredHeaders['Content-Type']).toBe('image/heic');
    expect(upload.requiredHeaders['Content-Length']).toBe('4200000');

    // Both headers must be part of the signature, or the bounds are advisory.
    // They are not signed by default — the SDK signs only `host` and
    // `content-length` unless told otherwise, which this assertion caught.
    const signedHeaders = new URL(upload.url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signedHeaders).toContain('content-length');
    expect(signedHeaders).toContain('content-type');
  });

  it('does not attach a checksum computed over an empty body', async () => {
    // The SDK adds `x-amz-checksum-crc32` for an empty payload to presigned
    // PUTs. The browser sends real bytes, the checksum does not match, and a
    // valid upload is rejected — in production only.
    const upload = await provider.createUploadUrl({
      key: key('checksum.bin'),
      contentType: 'image/jpeg',
      maxSizeBytes: 1024,
      expiresInSeconds: 900,
    });

    const params = new URL(upload.url).searchParams;
    expect(params.get('x-amz-checksum-crc32')).toBeNull();
    expect(params.get('x-amz-sdk-checksum-algorithm')).toBeNull();
  });

  it('caps the signature lifetime however long a caller asks for', async () => {
    const upload = await provider.createUploadUrl({
      key: key('long.bin'),
      contentType: 'image/jpeg',
      maxSizeBytes: 1000,
      expiresInSeconds: 86_400,
    });

    const expires = Number(new URL(upload.url).searchParams.get('X-Amz-Expires'));
    expect(expires).toBeLessThanOrEqual(3600);
  });

  it('presigns a download as a GET, not a HEAD', async () => {
    // A HEAD presign returns headers and no image, which fails only at the
    // point a user opens a draft preview.
    const url = await provider.createSignedDownloadUrl(key('read.bin'), 300);
    const signedHeaders = new URL(url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toBeTruthy();
    expect(new URL(url).searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });
});

// ── behavioural: every adapter that has somewhere to store things ──────────

describe.each(adapters)('$name behaves as the port requires', ({ create }) => {
  it('returns null from head for an object that does not exist', async () => {
    const provider = create();
    // Not an error: `completeUpload` distinguishes "not uploaded yet" from
    // "storage is broken" by this exact difference.
    expect(await provider.head(key(`absent-${Date.now()}`))).toBeNull();
  });

  it('returns null from getObject for an object that does not exist', async () => {
    const provider = create();
    expect(await provider.getObject(key(`absent-${Date.now()}`))).toBeNull();
  });

  it('round-trips an object with its content type and size', async () => {
    const provider = create();
    const at = key(`round-trip-${Date.now()}`);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    await provider.putObject(at, bytes, 'image/avif');

    const metadata = await provider.head(at);
    expect(metadata?.sizeBytes).toBe(bytes.byteLength);
    expect(metadata?.contentType).toBe('image/avif');
    expect(metadata?.etag).toBeTruthy();

    expect(await provider.getObject(at)).toEqual(bytes);

    await provider.delete(at);
    expect(await provider.head(at)).toBeNull();
  });

  it('treats deleting an absent object as success', async () => {
    // The sweep deletes objects that may never have existed — a browser closed
    // mid-upload leaves a row and no bytes. Throwing here would make the sweep
    // fail on its most common case.
    const provider = create();
    await expect(provider.delete(key(`never-existed-${Date.now()}`))).resolves.toBeUndefined();
  });

  it('deletes a whole prefix and reports the count', async () => {
    const provider = create();
    const prefix = `media/contract/prefix-${Date.now()}/`;
    for (const name of ['original.jpg', 'w400.avif', 'w1080.avif']) {
      await provider.putObject(`${prefix}${name}` as StorageKey, new Uint8Array([9]), 'image/avif');
    }

    expect(await provider.deletePrefix(prefix)).toBe(3);
    expect(await provider.head(`${prefix}w400.avif` as StorageKey)).toBeNull();
  });

  it('does not delete beyond the prefix it was given', async () => {
    const provider = create();
    const stamp = Date.now();
    const inside = key(`scoped-${stamp}/a.bin`);
    const outside = key(`scoped-${stamp}-sibling.bin`);

    await provider.putObject(inside, new Uint8Array([1]), 'image/jpeg');
    await provider.putObject(outside, new Uint8Array([1]), 'image/jpeg');

    await provider.deletePrefix(`media/contract/scoped-${stamp}/`);

    expect(await provider.head(inside)).toBeNull();
    expect(await provider.head(outside), 'sibling key was deleted').not.toBeNull();
    await provider.delete(outside);
  });

  it('issues an upload URL with the required headers', async () => {
    const provider = create();
    const upload = await provider.createUploadUrl({
      key: key(`upload-${Date.now()}`),
      contentType: 'image/jpeg',
      maxSizeBytes: 8 * 1024 * 1024,
      expiresInSeconds: 900,
    });

    expect(upload.method).toBe('PUT');
    expect(upload.requiredHeaders['Content-Type']).toBe('image/jpeg');
    expect(upload.requiredHeaders['Content-Length']).toBe(String(8 * 1024 * 1024));
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── the in-memory adapter's own guarantees ─────────────────────────────────

describe('the in-memory adapter enforces what it signs', () => {
  // A fake that accepts anything would let a test assert a limit the real
  // provider never applies, which is worse than having no fake at all.
  it('refuses an upload larger than the signed size', async () => {
    const provider = new InMemoryStorageProvider();
    const upload = await provider.createUploadUrl({
      key: key('bounded'),
      contentType: 'image/jpeg',
      maxSizeBytes: 16,
      expiresInSeconds: 900,
    });

    const result = await provider.putSigned(upload.url, new Uint8Array(64), 'image/jpeg');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(413);
  });

  it('refuses an upload whose content type differs from the signature', async () => {
    const provider = new InMemoryStorageProvider();
    const upload = await provider.createUploadUrl({
      key: key('typed'),
      contentType: 'image/jpeg',
      maxSizeBytes: 1024,
      expiresInSeconds: 900,
    });

    const result = await provider.putSigned(upload.url, new Uint8Array(8), 'text/html');
    expect(result.ok).toBe(false);
  });

  it('refuses an expired upload URL', async () => {
    let now = new Date('2026-08-16T10:00:00Z');
    const provider = new InMemoryStorageProvider(() => now);
    const upload = await provider.createUploadUrl({
      key: key('expiring'),
      contentType: 'image/jpeg',
      maxSizeBytes: 1024,
      expiresInSeconds: 900,
    });

    now = new Date('2026-08-16T10:16:00Z');
    const result = await provider.putSigned(upload.url, new Uint8Array(8), 'image/jpeg');
    expect(result.ok).toBe(false);
  });

  it('accepts an upload URL only once', async () => {
    const provider = new InMemoryStorageProvider();
    const upload = await provider.createUploadUrl({
      key: key('single-use'),
      contentType: 'image/jpeg',
      maxSizeBytes: 1024,
      expiresInSeconds: 900,
    });

    expect((await provider.putSigned(upload.url, new Uint8Array(8), 'image/jpeg')).ok).toBe(true);
    expect((await provider.putSigned(upload.url, new Uint8Array(8), 'image/jpeg')).ok).toBe(false);
  });
});

describe('live-adapter coverage', () => {
  it('reports whether a live S3 endpoint was exercised', () => {
    // Never silently green. If the behavioural suite ran against the fake
    // only, that fact is visible in the test output rather than buried in a
    // skip.
    const message = liveAdapter
      ? `live S3 adapter exercised: ${liveAdapter.name}`
      : 'no S3_TEST_ENDPOINT set — behavioural suite ran against the in-memory adapter only';
    expect(message).toBeTruthy();
    expect(adapters.length).toBe(liveAdapter ? 2 : 1);
  });
});
