import { createHash } from 'node:crypto';

import type { StorageKey } from '@zfaf/shared';
import type {
  CreateUploadUrlInput,
  ObjectMetadata,
  SignedUpload,
  StorageProvider,
} from '@zfaf/core';

/**
 * An in-memory storage provider.
 *
 * Its real job is to make the abstraction falsifiable. The contract suite runs
 * against this and against the S3 adapter; if a test only passes because both
 * implementations happen to be the same code, the suite proves nothing. This
 * one shares no line with the S3 adapter, so a test that passes on both is
 * testing the *port*.
 *
 * It is also what lets media use cases be tested without a bucket, and what
 * `pnpm dev` falls back to when MinIO is not running.
 *
 * It enforces the size and type bounds itself, deliberately. A fake that
 * accepts anything would let a test assert a limit that the real provider
 * never applies.
 */

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
}

interface PendingUpload {
  readonly key: StorageKey;
  readonly contentType: string;
  readonly maxSizeBytes: number;
  readonly expiresAt: Date;
}

export class InMemoryStorageProvider implements StorageProvider {
  readonly key = 'in-memory';

  private readonly objects = new Map<string, StoredObject>();
  private readonly pending = new Map<string, PendingUpload>();
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async createUploadUrl(input: CreateUploadUrlInput): Promise<SignedUpload> {
    this.counter += 1;
    const token = `upload-${this.counter}`;
    const expiresAt = new Date(this.now().getTime() + input.expiresInSeconds * 1000);

    this.pending.set(token, {
      key: input.key,
      contentType: input.contentType,
      maxSizeBytes: input.maxSizeBytes,
      expiresAt,
    });

    return {
      url: `memory://upload/${token}`,
      method: 'PUT',
      requiredHeaders: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.maxSizeBytes),
      },
      expiresAt,
    };
  }

  /**
   * Performs what the browser's `PUT` would.
   *
   * Not part of `StorageProvider` — the real one is done by the client against
   * the object store. It is on this class so a test can exercise the whole
   * three-stage flow, and it applies the same constraints the signature does,
   * so a test cannot pass by uploading something the bound forbids.
   */
  async putSigned(
    url: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
    const token = url.replace('memory://upload/', '');
    const upload = this.pending.get(token);
    if (!upload) return { ok: false, status: 403, reason: 'Unknown or already-used upload URL' };

    if (this.now() > upload.expiresAt) {
      this.pending.delete(token);
      return { ok: false, status: 403, reason: 'Upload URL has expired' };
    }
    if (contentType !== upload.contentType) {
      return { ok: false, status: 403, reason: 'Content-Type does not match the signature' };
    }
    if (bytes.byteLength > upload.maxSizeBytes) {
      return { ok: false, status: 413, reason: 'Object exceeds the signed size limit' };
    }

    this.objects.set(upload.key, {
      bytes: bytes.slice(),
      contentType,
      etag: createHash('md5').update(bytes).digest('hex'),
      lastModified: this.now(),
    });
    // Single-use, like a real presigned URL that has been consumed.
    this.pending.delete(token);
    return { ok: true };
  }

  /** Places an object directly, for tests that are not about the upload flow. */
  seed(key: StorageKey, bytes: Uint8Array, contentType: string): void {
    this.objects.set(key, {
      bytes: bytes.slice(),
      contentType,
      etag: createHash('md5').update(bytes).digest('hex'),
      lastModified: this.now(),
    });
  }

  async getObject(key: StorageKey): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes.slice() ?? null;
  }

  async putObject(key: StorageKey, bytes: Uint8Array, contentType: string): Promise<void> {
    this.seed(key, bytes, contentType);
  }

  async createSignedDownloadUrl(key: StorageKey, ttlSeconds: number): Promise<string> {
    const expires = this.now().getTime() + ttlSeconds * 1000;
    return `memory://download/${encodeURIComponent(key)}?expires=${expires}`;
  }

  async head(key: StorageKey): Promise<ObjectMetadata | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      sizeBytes: object.bytes.byteLength,
      contentType: object.contentType,
      etag: object.etag,
      lastModified: object.lastModified,
    };
  }

  async delete(key: StorageKey): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Test introspection: what is actually stored. */
  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }
}
