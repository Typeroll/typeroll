// Build-time srcset variant pipeline.
//
// For each uploaded image, generate webp + avif variants at common
// responsive sizes (320 / 640 / 1024 / 1920) so the site can emit
// <img srcset="..."> without any runtime image transformation service.
// All variants land on R2 alongside the original; the media doc gains a
// `variants` array describing what was produced.
//
// Cost model: zero per-request fees ever. We pay R2 storage for the
// variants (typically 5x the original size summed, but webp/avif are
// efficient so for a 500KB JPEG you might see ~600KB of variants total).
//
// Trigger: explicit per-media call, not automatic at upload-time. The
// agent decides when to run it (typically after `create_upload_url` +
// PUT completes, or in a sweep over `list_media` for legacy media). One
// generate run takes ~1-5s per image — bounded, synchronous, no queue.
//
// Skip rules:
//   - Source format isn't an image we can process → return null
//   - Variant width >= source width → skip (don't upscale)
//   - Source format matches target format + size → skip (would be a
//     no-op copy)

import path from 'node:path';
import sharp from 'sharp';
import type { Media, MediaVariant } from '@typeroll/shared';

const VARIANT_WIDTHS = [320, 640, 1024, 1920] as const;
const VARIANT_FORMATS = ['webp', 'avif'] as const;

const PROCESSABLE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
]);

export interface GenerateVariantsConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBase: string; // e.g. https://cdn.example.com
}

export interface GenerateVariantsResult {
  variants: MediaVariant[];
  /** Width × height of the source image, useful for emitting an outer
   *  `<img width height>` so layout doesn't jump on load. */
  source_width: number;
  source_height: number;
  /** Sum of all variant sizes in bytes. */
  total_variant_bytes: number;
  /** Variants skipped because they would have been upscales. */
  skipped: string[];
}

/**
 * Variant-generation entry point. Reads the original from R2, produces
 * variants via sharp, uploads them, returns the variants payload to
 * persist on the Media doc.
 *
 * The caller is responsible for actually writing the `variants` field
 * onto the Media doc — we don't touch the datastore here, just R2 +
 * compute. Keeps this lib pure-pipeline.
 */
export async function generateImageVariants(
  media: Media,
  config: GenerateVariantsConfig,
): Promise<GenerateVariantsResult | null> {
  if (!media.mime_type || !PROCESSABLE_MIME.has(media.mime_type)) return null;
  if (!media.r2_key) {
    throw new Error('media.r2_key is required to read the source object');
  }

  // Lazy-import the AWS SDK so test environments that don't actually run
  // the variant pipeline don't pay the import cost.
  const { S3Client, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  // Download source.
  const srcResp = await r2.send(new GetObjectCommand({ Bucket: config.bucket, Key: media.r2_key }));
  if (!srcResp.Body) throw new Error(`R2 object body is empty: ${media.r2_key}`);
  const srcBytes = await streamToBuffer(srcResp.Body as NodeJS.ReadableStream);
  const sourceMeta = await sharp(srcBytes).metadata();
  const sourceWidth = sourceMeta.width ?? 0;
  const sourceHeight = sourceMeta.height ?? 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error('Could not read source image dimensions');
  }

  // For each (width, format) combination, produce a variant unless it'd
  // be an upscale.
  const variants: MediaVariant[] = [];
  const skipped: string[] = [];
  const baseKey = stripExt(media.r2_key);

  for (const width of VARIANT_WIDTHS) {
    if (width >= sourceWidth) {
      skipped.push(`${width}w (>= source ${sourceWidth}w)`);
      continue;
    }
    for (const format of VARIANT_FORMATS) {
      const variantKey = `${baseKey}.w${width}.${format}`;
      const buf = await sharp(srcBytes)
        .resize({ width, withoutEnlargement: true })
        [format]({ quality: format === 'avif' ? 60 : 80 })
        .toBuffer();
      await r2.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: variantKey,
        Body: buf,
        ContentType: `image/${format}`,
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      variants.push({
        width,
        format,
        cdn_url: `${config.publicBase.replace(/\/$/, '')}/${variantKey}`,
        size_bytes: buf.byteLength,
      });
    }
  }

  const totalBytes = variants.reduce((sum, v) => sum + v.size_bytes, 0);
  return {
    variants,
    source_width: sourceWidth,
    source_height: sourceHeight,
    total_variant_bytes: totalBytes,
    skipped,
  };
}

/**
 * Build an `<img srcset>` value from a Media doc's variants. Sorted
 * ascending so the largest size is last (browsers expect this).
 * Filters by format so you can emit one `<source srcset>` per format
 * in a `<picture>` element.
 */
export function buildSrcset(
  variants: MediaVariant[] | undefined,
  format: MediaVariant['format'],
): string | null {
  if (!variants || variants.length === 0) return null;
  const matching = variants
    .filter((v) => v.format === format)
    .sort((a, b) => a.width - b.width);
  if (matching.length === 0) return null;
  return matching.map((v) => `${v.cdn_url} ${v.width}w`).join(', ');
}

function stripExt(key: string): string {
  const ext = path.extname(key);
  return ext ? key.slice(0, -ext.length) : key;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
