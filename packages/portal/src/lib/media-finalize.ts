// Post-upload finalize for R2-hosted media.
//
// Two problems this module solves:
//
//   1. Presigned PUTs don't apply Cache-Control. The signed URL is just
//      `Bucket+Key+ContentType`, so when the browser PUTs the object,
//      R2 stores it with no Cache-Control header. CDN downstream then
//      uses whatever default (~4h) — every visitor pays for re-fetching
//      hero PNGs. The autopilot.se Lighthouse report flagged 1.1 MiB
//      avoidable transfer from this alone.
//
//   2. Variants (the 320/640/1024/1920 × {webp,avif} pipeline in
//      lib/image-variants.ts) need to be generated, but the trigger was
//      "agent calls generate-variants per media". Sites where no agent
//      ever ran the sweep ship the original PNG at full resolution to
//      every viewport.
//
// Solution: `finalizeMedia(orgId, siteId, mediaId)` does both atomically:
//   - CopyObject in place with `MetadataDirective: 'REPLACE'` to apply
//     immutable Cache-Control (and preserve original ContentType). Same
//     bytes — just rewrites the metadata. Cheap; R2 doesn't bill
//     per-byte for an in-place copy.
//   - Runs the variant pipeline if the doc doesn't already carry variants.
//
// Idempotent: calling twice on the same media is a no-op the second time
// for both halves (CacheControl is already set; variants array is
// already populated). That makes the same function usable for
// "call after upload" and "backfill the library" — see the
// `/media/{mediaId}/finalize` endpoint and the bulk variant.

import { getStore } from './datastore';
import { generateImageVariants } from './image-variants';
import { paths } from '@typeroll/shared';
import type { Media } from '@typeroll/shared';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export interface FinalizeConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBase: string;
}

export interface FinalizeResult {
  /** True when cache headers were applied (always true on success). */
  cache_headers_applied: boolean;
  /** True when this call generated variants (false when they already existed). */
  variants_generated: boolean;
  /** Number of variant files produced this call. 0 on already-finalized media. */
  variant_count: number;
  /** Source image dimensions, only set when variants were generated this call
   *  or were already on the doc. */
  width?: number;
  height?: number;
  /**
   * sha256 (hex) of the stored original — ALWAYS computed so callers can
   * byte-verify an upload for free. Eval finding #20: a base64 payload
   * mutated in transit uploads "successfully" with the right size and only
   * fails when rendered; comparing this hash against the source bytes is
   * how an agent catches that before referencing the asset.
   */
  sha256: string;
  size_bytes: number;
}

/** Upload corruption detected at finalize — callers map this to a 422. */
export class MediaIntegrityError extends Error {}

/** Truncation guard for SVGs: a partial upload loses the closing tag.
 *  (Mid-file mutations are the hash comparison's job — XML is too lenient
 *  to catch a flipped character reliably without a full strict parser.) */
export function svgLooksComplete(bytes: Buffer): boolean {
  const text = bytes.toString('utf8').trimEnd();
  return /<svg[\s>]/i.test(text) && /<\/svg\s*>$/i.test(text);
}

/**
 * Finalize one media item. Safe to call on already-finalized media (no-op
 * effectively); always safe to call on uploaded-but-untouched media.
 *
 * @throws when the media doc is missing or the R2 object can't be read.
 */
export async function finalizeMedia(
  orgId: string,
  siteId: string,
  mediaId: string,
  config: FinalizeConfig,
  opts?: {
    /** Compare the stored bytes against this sha256 (hex); mismatch throws
     *  MediaIntegrityError. Pass it when the caller knows the source hash
     *  (e.g. an agent that hashed the file before the PUT). */
    expectedSha256?: string;
  },
): Promise<FinalizeResult> {
  const store = getStore();
  const media = await store.getDoc<Media>(`${paths.media(orgId, siteId)}/${mediaId}`);
  if (!media) throw new Error(`Media ${mediaId} not found`);
  if (!media.r2_key) throw new Error(`Media ${mediaId} has no r2_key — cannot finalize`);

  // Integrity first — never bless corrupted bytes with immutable cache
  // headers. One GetObject per finalize call (finalize is once per upload).
  const { S3Client, CopyObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Same v3.700+ checksum-middleware quirk as upload-url.ts — CopyObject
    // with the default middleware also produces requests R2 rejects.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const obj = await r2.send(new GetObjectCommand({ Bucket: config.bucket, Key: media.r2_key }));
  const bytes = Buffer.from(await (obj.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  if (opts?.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256) {
    throw new MediaIntegrityError(
      `Stored bytes don't match expected_sha256 (stored: ${sha256}, ${bytes.length} bytes) — ` +
      'the upload was corrupted in transit. Re-upload via create_upload_url + a direct binary PUT ' +
      '(never re-transcribe large payloads through upload_media_inline).',
    );
  }
  if (media.mime_type === 'image/svg+xml' && !svgLooksComplete(bytes)) {
    throw new MediaIntegrityError(
      `SVG ${mediaId} looks truncated (no closing </svg>, ${bytes.length} bytes stored) — ` +
      're-upload via create_upload_url + a direct binary PUT.',
    );
  }

  await r2.send(new CopyObjectCommand({
    Bucket: config.bucket,
    Key: media.r2_key,
    CopySource: `${config.bucket}/${media.r2_key}`,
    MetadataDirective: 'REPLACE',
    CacheControl: IMMUTABLE_CACHE,
    ContentType: media.mime_type,
  }));

  // Variant generation — skip when the doc already carries variants.
  // Re-running would re-upload the same bytes for no gain.
  const hasVariants = Array.isArray(media.variants) && media.variants.length > 0;
  if (hasVariants) {
    return {
      cache_headers_applied: true,
      variants_generated: false,
      variant_count: media.variants?.length ?? 0,
      width: media.width,
      height: media.height,
      sha256,
      size_bytes: bytes.length,
    };
  }

  const result = await generateImageVariants(media, config);
  if (!result) {
    // Non-image (PDF etc.) — cache headers applied, no variants to make.
    return {
      cache_headers_applied: true,
      variants_generated: false,
      variant_count: 0,
      sha256,
      size_bytes: bytes.length,
    };
  }

  await store.setDoc(`${paths.media(orgId, siteId)}/${mediaId}`, {
    ...media,
    width: result.source_width,
    height: result.source_height,
    variants: result.variants,
  });

  return {
    cache_headers_applied: true,
    variants_generated: true,
    variant_count: result.variants.length,
    width: result.source_width,
    height: result.source_height,
    sha256,
    size_bytes: bytes.length,
  };
}

/**
 * Finalize every media item in a site's library that hasn't been finalized
 * yet. Cheap per-media (CopyObject is just metadata; variant skip is one
 * doc read). Used by the bulk-backfill endpoint to fix sites uploaded
 * before this pipeline existed.
 *
 * Returns counts so the caller can surface progress.
 */
export async function finalizeAllMedia(
  orgId: string,
  siteId: string,
  config: FinalizeConfig,
): Promise<{
  total: number;
  finalized: number;
  skipped: number;
  errors: Array<{ media_id: string; error: string }>;
}> {
  const store = getStore();
  const list = await store.listDocs<Media>(paths.media(orgId, siteId));
  let finalized = 0;
  let skipped = 0;
  const errors: Array<{ media_id: string; error: string }> = [];
  for (const m of list) {
    if (!m.r2_key) {
      // Legacy media uploaded before r2_key was stored — can't finalize.
      skipped++;
      continue;
    }
    try {
      const result = await finalizeMedia(orgId, siteId, m.id, config);
      if (result.variants_generated || result.cache_headers_applied) {
        finalized++;
      } else {
        skipped++;
      }
    } catch (e) {
      errors.push({
        media_id: m.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { total: list.length, finalized, skipped, errors };
}
