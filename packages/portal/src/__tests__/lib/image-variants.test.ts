// generateImageVariants — exercises the sharp pipeline against a
// synthetic in-memory image, with the AWS SDK mocked to capture the
// upload calls without touching R2.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import type { Media } from '@typeroll/shared';

// Construct a 1500-wide red PNG so we know which sizes the variant
// pipeline will skip (the 1920 width is larger and should drop).
async function makeSourceJpeg(width: number): Promise<Buffer> {
  return sharp({
    create: { width, height: Math.round(width * 0.5625), channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg({ quality: 80 }).toBuffer();
}

interface CapturedPut {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType: string;
  CacheControl?: string;
}

describe('generateImageVariants', () => {
  let captured: CapturedPut[];

  beforeEach(() => {
    captured = [];
    vi.resetModules();
    vi.doMock('@aws-sdk/client-s3', async () => {
      const sourceBytes = await makeSourceJpeg(1500);
      return {
        S3Client: class {
          async send(command: { input: unknown; constructor: { name: string } }): Promise<unknown> {
            const name = command.constructor.name;
            if (name === 'GetObjectCommand') {
              // Return a readable stream with the synthetic source.
              return {
                Body: {
                  on(event: string, cb: (...a: unknown[]) => void): void {
                    if (event === 'data') cb(sourceBytes);
                    if (event === 'end') queueMicrotask(() => cb());
                  },
                },
              };
            }
            if (name === 'PutObjectCommand') {
              captured.push(command.input as CapturedPut);
              return {};
            }
            throw new Error(`unexpected command ${name}`);
          }
        },
        GetObjectCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
        PutObjectCommand: class { input: unknown; constructor(input: unknown) { this.input = input; } },
      };
    });
  });

  function buildMedia(): Media {
    return {
      id: 'm1',
      filename: 'photo.jpg',
      cdn_url: 'https://cdn.example.com/orgs/o/sites/s/images/photo.jpg',
      r2_key: 'orgs/o/sites/s/images/photo.jpg',
      mime_type: 'image/jpeg',
      created_at: new Date().toISOString(),
    };
  }

  it('produces webp + avif variants at every size below the source width', async () => {
    const { generateImageVariants } = await import('../../lib/image-variants');
    const media = buildMedia();
    const result = await generateImageVariants(media, {
      accountId: 'acct', bucket: 'bkt',
      accessKeyId: 'k', secretAccessKey: 's',
      publicBase: 'https://cdn.example.com',
    });
    expect(result).not.toBeNull();
    if (!result) return;
    // Source is 1500w, so 320 + 640 + 1024 fit (1920 is skipped).
    // 3 widths × 2 formats = 6 variants.
    expect(result.variants).toHaveLength(6);
    const formats = new Set(result.variants.map((v) => v.format));
    expect(formats).toEqual(new Set(['webp', 'avif']));
    const widths = new Set(result.variants.map((v) => v.width));
    expect(widths).toEqual(new Set([320, 640, 1024]));
    expect(result.skipped.some((s) => s.includes('1920w'))).toBe(true);
    expect(result.source_width).toBe(1500);
  });

  it('uploads each variant to a predictable R2 key', async () => {
    const { generateImageVariants } = await import('../../lib/image-variants');
    const media = buildMedia();
    await generateImageVariants(media, {
      accountId: 'acct', bucket: 'bkt',
      accessKeyId: 'k', secretAccessKey: 's',
      publicBase: 'https://cdn.example.com',
    });
    // 6 puts (3 widths × 2 formats).
    expect(captured.length).toBe(6);
    const keys = captured.map((p) => p.Key).sort();
    expect(keys).toContain('orgs/o/sites/s/images/photo.w320.webp');
    expect(keys).toContain('orgs/o/sites/s/images/photo.w320.avif');
    expect(keys).toContain('orgs/o/sites/s/images/photo.w1024.avif');
    // All variants get the immutable cache header so CF caches them forever.
    for (const c of captured) {
      expect(c.CacheControl).toBe('public, max-age=31536000, immutable');
    }
  });

  it('returns null for non-image mime types (e.g. PDF)', async () => {
    const { generateImageVariants } = await import('../../lib/image-variants');
    const result = await generateImageVariants(
      {
        id: 'm1', filename: 'doc.pdf',
        cdn_url: 'https://cdn.example.com/doc.pdf',
        r2_key: 'doc.pdf',
        mime_type: 'application/pdf',
        created_at: new Date().toISOString(),
      },
      {
        accountId: 'acct', bucket: 'bkt',
        accessKeyId: 'k', secretAccessKey: 's',
        publicBase: 'https://cdn.example.com',
      },
    );
    expect(result).toBeNull();
  });
});

describe('buildSrcset', () => {
  it('produces a sorted srcset string for one format', async () => {
    const { buildSrcset } = await import('../../lib/image-variants');
    const srcset = buildSrcset(
      [
        { width: 640, format: 'webp', cdn_url: 'https://cdn/a-640.webp', size_bytes: 0 },
        { width: 320, format: 'webp', cdn_url: 'https://cdn/a-320.webp', size_bytes: 0 },
        { width: 320, format: 'avif', cdn_url: 'https://cdn/a-320.avif', size_bytes: 0 },
      ],
      'webp',
    );
    expect(srcset).toBe('https://cdn/a-320.webp 320w, https://cdn/a-640.webp 640w');
  });

  it('returns null when no variants of that format exist', async () => {
    const { buildSrcset } = await import('../../lib/image-variants');
    expect(buildSrcset([{ width: 320, format: 'webp', cdn_url: 'x', size_bytes: 0 }], 'avif'))
      .toBeNull();
    expect(buildSrcset(undefined, 'webp')).toBeNull();
    expect(buildSrcset([], 'webp')).toBeNull();
  });
});
