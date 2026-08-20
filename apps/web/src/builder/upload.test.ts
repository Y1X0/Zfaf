import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as mediaClient from '@zfaf/media-client';
import * as api from '../auth/api.js';
import { uploadImage } from './upload.js';

vi.mock('@zfaf/media-client');
vi.mock('../auth/api.js');

describe('uploadImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs with the compressed file size, not the original', async () => {
    const originalSize = 4_000_000;
    const compressedSize = 400_000;

    const originalFile = new File(
      [new ArrayBuffer(originalSize)],
      'photo.heic',
      { type: 'image/heic' },
    );
    const compressedFile = new File(
      [new ArrayBuffer(compressedSize)],
      'photo.jpg',
      { type: 'image/jpeg' },
    );

    vi.mocked(mediaClient.canCompressInBrowser).mockReturnValue(true);
    vi.mocked(mediaClient.compressBeforeUpload).mockResolvedValue({
      file: compressedFile,
      compressed: true,
      originalBytes: originalSize,
      resultBytes: compressedSize,
    });

    vi.mocked(api.apiSend).mockResolvedValueOnce({
      ok: true,
      data: {
        mediaId: 'media-123',
        upload: {
          url: 'https://s3.example.com/upload',
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
        },
      },
    });

    // Mock the remaining stages
    vi.mocked(api.apiSend).mockResolvedValueOnce({
      ok: true,
      data: {},
    });

    vi.mocked(api.apiGet).mockResolvedValue({
      ok: true,
      data: {
        status: 'ready',
        url: 'https://cdn.example.com/photo.jpg',
        width: 1920,
        height: 1080,
        blurhash: 'abc123',
      },
    });

    await uploadImage(originalFile, {
      invitationId: 'inv-123',
      purpose: 'cover',
    });

    // Verify the signature request used the compressed size
    const signRequest = vi.mocked(api.apiSend).mock.calls[0];
    expect(signRequest).toBeDefined();
    expect(signRequest![0]).toBe('/api/v1/media/upload-url');
    expect((signRequest![2] as Record<string, unknown>)['sizeBytes']).toBe(compressedSize);
  });
});
