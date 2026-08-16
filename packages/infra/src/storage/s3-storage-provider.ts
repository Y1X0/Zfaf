import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageKey } from '@zfaf/shared';
import type {
  CreateUploadUrlInput,
  ObjectMetadata,
  SignedUpload,
  StorageProvider,
} from '@zfaf/core';

/**
 * The S3-compatible storage adapter (ADR-0007, D4.1).
 *
 * R2 and MinIO are **the same adapter with different configuration**, and that
 * is the finding rather than a shortcut: both speak the S3 API, so writing two
 * near-identical classes would be duplication dressed up as abstraction. What
 * proves the abstraction is that the contract suite in
 * `storage-provider.contract.test.ts` is written against the port and runs
 * unchanged against this adapter *and* against a completely different
 * in-memory implementation.
 *
 * The AWS SDK is imported here and nowhere else. A `dependency-cruiser` rule
 * fails the build if it appears outside this directory, so swapping providers
 * stays a one-directory change (ADR-0007, amendment).
 */

export interface S3StorageConfig {
  /** `r2`, `minio`, `s3` — recorded on the provider and in audit entries. */
  readonly driver: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * MinIO addresses buckets by path; R2 and S3 by virtual host.
   *
   * Getting this wrong produces signatures that verify locally and fail in
   * production, which is exactly the class of bug running the same contract
   * tests against both is meant to catch.
   */
  readonly forcePathStyle: boolean;
}

/** Never signed for longer than this, whatever a caller asks. */
const MAX_URL_TTL_SECONDS = 3600;

export class S3StorageProvider implements StorageProvider {
  readonly key: string;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.key = config.driver;
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Without this the SDK adds a CRC32 of an *empty* body to every
      // presigned PUT. The browser then sends real bytes whose checksum does
      // not match, and the store rejects an upload that is perfectly valid.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Signs an upload URL bound to one key, one method, one type and one size.
   *
   * `ContentLength` in the signed command is what makes the size bound real.
   * Without it the client may send any number of bytes to a URL we issued for
   * a 4 MB photo, and the first we would know is the storage bill
   * (docs/10-storage-and-media.md §4 ①).
   */
  async createUploadUrl(input: CreateUploadUrlInput): Promise<SignedUpload> {
    const expiresIn = Math.min(input.expiresInSeconds, MAX_URL_TTL_SECONDS);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.maxSizeBytes,
    });

    // `signableHeaders` is what makes the bounds real. Left to itself the SDK
    // signs only `host` and `content-length`, so the content type would be a
    // header we *ask* the client to send rather than one it *must* — and an
    // upload could arrive as text/html into a bucket we serve.
    const url = await getSignedUrl(this.client, command, {
      expiresIn,
      signableHeaders: new Set(['content-type', 'content-length']),
    });

    return {
      url,
      method: 'PUT',
      // Returned explicitly so the client cannot omit them: a request whose
      // headers differ from the signed ones is rejected by the store, which is
      // the point.
      requiredHeaders: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.maxSizeBytes),
      },
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * A short-lived read URL for drafts and previews.
   *
   * Drafts are not public, so they cannot be served from the CDN like a
   * published invitation's assets. The presign is deliberately narrow: one
   * key, GET only, minutes not hours.
   */
  async createSignedDownloadUrl(key: StorageKey, ttlSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, {
      expiresIn: Math.min(ttlSeconds, MAX_URL_TTL_SECONDS),
    });
  }

  /** The source of truth for size and type after an upload. */
  async head(key: StorageKey): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? 'application/octet-stream',
        etag: (result.ETag ?? '').replaceAll('"', ''),
        lastModified: result.LastModified ?? new Date(0),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getObject(key: StorageKey): Promise<Uint8Array | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return new Uint8Array(await result.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async putObject(key: StorageKey, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        // Derivatives are content-addressed by their key and never rewritten,
        // so they can be cached for a year (ADR-0007).
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  /** Idempotent: deleting an absent object is a success, not an error. */
  async delete(key: StorageKey): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          // The S3 delete-objects cap. Paginating rather than assuming one page
          // matters for an account deletion with thousands of objects.
          MaxKeys: 1000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );

      const objects = (listed.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => typeof key === 'string');

      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += objects.length;
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    return deleted;
  }
}

function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    named.name === 'NotFound' ||
    named.name === 'NoSuchKey' ||
    named.$metadata?.httpStatusCode === 404
  );
}
