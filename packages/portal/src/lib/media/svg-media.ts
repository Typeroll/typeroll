// SVG media is stored only in sanitized form (see ./svg-sanitize.ts).
//
// Every path where SVG bytes become media runs through this module before the
// bytes are frozen or made public:
//   - organization/draft storage: finalizeOrganizationMedia() sanitizes the
//     private upload object, then hands the sanitized hash to
//     finalizeStoredMedia() so a replayed presigned PUT cannot swap the bytes
//     between sanitizing and freezing;
//   - URL and WordPress imports: sanitizeTransferredSvg() rewrites the object
//     the customer's transfer Worker copied, before finalizeTransferredMedia();
//   - platform (legacy) storage: uploads are staged in the private bucket and
//     finalizeMedia() publishes only sanitized bytes (lib/media-finalize.ts).

import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { finalizeStoredMedia, storageClient } from '../publishing/media-storage';
import type { TransferReceipt } from './remote-transfer';
import { sanitizeSvg, SvgSanitizeError } from './svg-sanitize';
import { requiresSvgSanitization, SVG_MEDIA_TYPE } from './file-types';

export { SVG_MEDIA_TYPE, isScriptableMediaType, requiresSvgSanitization } from './file-types';
const MAX_BYTES = 25 * 1024 * 1024;

export interface SvgSanitizedMarker {
  /** sha256 of the bytes as uploaded or imported. */
  source_sha256: string;
  /** sha256 of the sanitized bytes that are stored. */
  sha256: string;
  removed: string[];
}
export type SvgMedia = Media & {
  svg_sanitized?: SvgSanitizedMarker;
  /** Platform storage only: private staging object awaiting finalize. */
  svg_staging_key?: string | null;
};

/** The upload is not an SVG this server can make inert. Finalize answers 400 and nothing is published. */
export class SvgRejectedError extends ConnectionError {
  constructor(reason: string) {
    super(`The SVG was rejected: ${reason} Export it again as a plain SVG and upload the new file.`, 400, 'media_svg_invalid');
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface SanitizedSvgObject {
  sha256: string;
  size: number;
  etag: string;
  source_sha256: string;
  source_size: number;
  changed: boolean;
  removed: string[];
}

/**
 * Read one object, sanitize it and write the result back to the same key.
 * `etag` pins the read to a verified version; `expectedSha256`/`expectedSize`
 * describe the bytes as read. Throws SvgRejectedError for unusable input.
 */
export async function sanitizeSvgObject(client: S3Client, input: {
  bucket: string; key: string; etag?: string; expectedSha256?: string; expectedSize?: number;
  cacheControl: string; writeBucket?: string; writeKey?: string;
}): Promise<SanitizedSvgObject> {
  const object = await client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key, ...(input.etag ? { IfMatch: input.etag } : {}) }),
    { abortSignal: AbortSignal.timeout(30_000) });
  if (!object.Body || (object.ContentLength !== undefined && object.ContentLength > MAX_BYTES)) {
    throw new ConnectionError('The uploaded file has an unexpected size. Upload it again.', 422, 'media_integrity_failed');
  }
  const raw = Buffer.from(await object.Body.transformToByteArray());
  if (raw.length > MAX_BYTES || (input.expectedSize !== undefined && raw.length !== input.expectedSize)) {
    throw new ConnectionError('The uploaded file has an unexpected size. Upload it again.', 422, 'media_integrity_failed');
  }
  const sourceSha = sha256(raw);
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sourceSha) {
    throw new ConnectionError('The stored image does not match expected_sha256. Upload it again.', 422, 'media_integrity_failed');
  }
  let sanitized: Buffer, removed: string[];
  try { ({ bytes: sanitized, removed } = sanitizeSvg(raw)); }
  catch (error) {
    if (error instanceof SvgSanitizeError && error.kind === 'truncated') {
      throw new ConnectionError(`The SVG looks truncated (${raw.length} bytes stored): ${error.message} Upload it again with a direct binary PUT.`, 422, 'media_svg_truncated');
    }
    if (error instanceof SvgSanitizeError) throw new SvgRejectedError(error.message);
    throw error;
  }
  const writeBucket = input.writeBucket ?? input.bucket, writeKey = input.writeKey ?? input.key;
  const changed = !sanitized.equals(raw);
  let etag = object.ETag ?? '';
  if (changed || writeBucket !== input.bucket || writeKey !== input.key) {
    const written = await client.send(new PutObjectCommand({ Bucket: writeBucket, Key: writeKey, Body: sanitized,
      ContentType: SVG_MEDIA_TYPE, CacheControl: input.cacheControl }), { abortSignal: AbortSignal.timeout(30_000) });
    etag = written.ETag ?? '';
  }
  if (!etag) throw new ConnectionError('Storage did not confirm the sanitized SVG. Retry finalizing the upload.', 503, 'media_storage_unavailable');
  return { sha256: sha256(sanitized), size: sanitized.length, etag, source_sha256: sourceSha, source_size: raw.length, changed, removed };
}

type StoredFinalizeResult = Awaited<ReturnType<typeof finalizeStoredMedia>>;
export type OrganizationFinalizeResult = StoredFinalizeResult & { svg_sanitized?: boolean; source_sha256?: string; removed?: string[] };

/**
 * Finalize media in organization or draft storage. SVG uploads are sanitized
 * in their private upload object first; every other file is unchanged.
 */
export async function finalizeOrganizationMedia(orgId: string, siteId: string, mediaId: string, expectedSha256?: string): Promise<OrganizationFinalizeResult> {
  const store = getStore(), path = `${paths.media(orgId, siteId)}/${mediaId}`;
  const media = await store.getDoc<SvgMedia>(path);
  if (!media?.storage || !requiresSvgSanitization(media)) return finalizeStoredMedia(orgId, siteId, mediaId, expectedSha256);
  const marker = media.svg_sanitized;
  // Callers verify with the hash of the file they sent; the stored hash is of the sanitized file.
  const sentOriginal = !!expectedSha256 && !!marker && expectedSha256.toLowerCase() === marker.source_sha256;
  const report = (result: StoredFinalizeResult, value: SvgSanitizedMarker): OrganizationFinalizeResult =>
    ({ ...result, svg_sanitized: true, source_sha256: value.source_sha256, removed: value.removed });
  if (media.storage.state === 'ready') {
    const result = await finalizeStoredMedia(orgId, siteId, mediaId, sentOriginal ? media.sha256 : expectedSha256);
    return marker ? report(result, marker) : result;
  }
  const location = media.storage;
  const r2 = await storageClient(orgId, location);
  let sanitized: SanitizedSvgObject;
  try {
    // A retry after an interrupted freeze reads the bytes this function already sanitized.
    const retry = !!marker && (sentOriginal || !expectedSha256);
    sanitized = await sanitizeSvgObject(r2, { bucket: location.bucket, key: location.key, cacheControl: 'private, no-store',
      expectedSha256: retry ? undefined : expectedSha256, expectedSize: retry ? undefined : media.size_bytes || undefined });
    if (retry && sanitized.changed && sentOriginal) throw new ConnectionError('The stored image does not match expected_sha256. Upload it again.', 422, 'media_integrity_failed');
  } finally { r2.destroy(); }
  const value: SvgSanitizedMarker = {
    source_sha256: marker && !sanitized.changed && marker.sha256 === sanitized.sha256 ? marker.source_sha256 : sanitized.source_sha256,
    sha256: sanitized.sha256, removed: marker && !sanitized.changed ? marker.removed : sanitized.removed,
  };
  const updated = await store.compareAndUpdateDoc<SvgMedia>(path, current => current.storage?.state === 'uploading' &&
    current.storage.key === location.key && current.storage.generation === location.generation,
  { mime_type: SVG_MEDIA_TYPE, size_bytes: sanitized.size, svg_sanitized: value });
  if (!updated) throw new ConnectionError('Media storage changed during upload verification. Retry finalizing the upload.', 409, 'media_revision_conflict');
  // Freezing verifies the sanitized hash, so bytes replaced after this point are refused.
  return report(await finalizeStoredMedia(orgId, siteId, mediaId, sanitized.sha256), value);
}

/**
 * Imports: sanitize the object the transfer Worker copied and return a receipt
 * for the sanitized version. finalizeTransferredMedia() freezes exactly that
 * version (CopySourceIfMatch on the returned ETag).
 */
export async function sanitizeTransferredSvg(orgId: string, siteId: string, mediaId: string, client: S3Client,
  location: { bucket: string; key: string }, receipt: TransferReceipt): Promise<TransferReceipt> {
  const path = `${paths.media(orgId, siteId)}/${mediaId}`;
  const sanitized = await sanitizeSvgObject(client, { bucket: location.bucket, key: location.key, etag: receipt.etag,
    expectedSha256: receipt.sha256, expectedSize: receipt.size, cacheControl: 'private, no-store' });
  const updated = await getStore().compareAndUpdateDoc<SvgMedia>(path, current => current.storage?.state === 'uploading' && current.storage.key === location.key,
    { mime_type: SVG_MEDIA_TYPE, size_bytes: sanitized.size,
      svg_sanitized: { source_sha256: sanitized.source_sha256, sha256: sanitized.sha256, removed: sanitized.removed } });
  if (!updated) throw new ConnectionError('Media upload changed before transfer completed.', 409, 'media_revision_conflict');
  return { ...receipt, sha256: sanitized.sha256, size: sanitized.size, etag: sanitized.etag };
}

/**
 * Platform storage serves every key of its bucket publicly, so an SVG is
 * never PUT there by the client: the presigned upload goes to the private
 * bucket and finalize publishes the sanitized bytes at the public key.
 */
export function platformSvgStaging(sitePrefix: string, safeFilename: string): { bucket: string; key: string } {
  const bucket = process.env.R2_PRIVATE_BUCKET;
  if (!bucket || bucket === process.env.R2_BUCKET) {
    throw new ConnectionError('SVG uploads need private staging storage on this server. The administrator must set R2_PRIVATE_BUCKET to a bucket without public access.', 503, 'svg_staging_unavailable');
  }
  return { bucket, key: `svg-staging/${sitePrefix}/${randomUUID()}/${safeFilename}` };
}

export interface SvgResanitizeReport {
  scanned: number;
  svg: number;
  unchanged: number;
  sanitized: Array<{ media_id: string; removed: string[]; previous_sha256?: string; sha256: string }>;
  rejected: Array<{ media_id: string; error: string }>;
  skipped: Array<{ media_id: string; reason: string }>;
  mode: 'dry-run' | 'apply';
}

/**
 * Maintenance: re-sanitize SVG media that was stored before sanitizing
 * existed. Organization and draft storage get a new immutable original
 * (originals/{sha256}/...) and the record moves to it; the site must be
 * republished for the public copy to change. Platform-storage SVGs are
 * re-sanitized by the next finalize or deploy backfill instead (finalizeMedia).
 * Dry run unless `apply` is set. Rejected files are reported, never deleted.
 * `mediaIds` limits the run to those records; publishing uses it for the
 * referenced SVGs that carry no sanitized marker.
 */
export async function resanitizeStoredSvgMedia(orgId: string, siteId: string, options: { apply?: boolean; mediaIds?: string[] } = {}): Promise<SvgResanitizeReport> {
  const store = getStore();
  const report: SvgResanitizeReport = { scanned: 0, svg: 0, unchanged: 0, sanitized: [], rejected: [], skipped: [], mode: options.apply ? 'apply' : 'dry-run' };
  const { siteMediaPrefix } = await import('../media-keys');
  const prefix = await siteMediaPrefix(orgId, siteId);
  const only = options.mediaIds ? new Set(options.mediaIds) : null;
  for (const media of await store.listDocs<SvgMedia>(paths.media(orgId, siteId))) {
    if (only && !only.has(media.id)) continue;
    report.scanned++;
    if (!requiresSvgSanitization(media)) continue;
    report.svg++;
    if (!media.storage) { report.skipped.push({ media_id: media.id, reason: 'platform storage: re-sanitized by finalize or the deploy backfill' }); continue; }
    if (media.storage.state !== 'ready') { report.skipped.push({ media_id: media.id, reason: 'upload not finalized: sanitized at finalize' }); continue; }
    const location = media.storage;
    const r2 = await storageClient(orgId, location);
    try {
      const key = (digest: string) => `private/${prefix}/originals/${digest}/${media.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      // Dry runs sanitize in memory only: the write target equals the source and nothing changes when bytes are identical.
      const object = await r2.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }), { abortSignal: AbortSignal.timeout(30_000) });
      const raw = Buffer.from(await object.Body!.transformToByteArray());
      let bytes: Buffer, removed: string[];
      try { ({ bytes, removed } = sanitizeSvg(raw)); }
      catch (error) { report.rejected.push({ media_id: media.id, error: error instanceof Error ? error.message : String(error) }); continue; }
      if (media.sha256 && sha256(raw) !== media.sha256) { report.rejected.push({ media_id: media.id, error: 'The stored file does not match its recorded hash.' }); continue; }
      if (bytes.equals(raw) && media.mime_type === SVG_MEDIA_TYPE) {
        // Already inert: record that, so publishing accepts it (lib/publishing/media-manifest.ts).
        if (options.apply && media.svg_sanitized?.sha256 !== media.sha256) {
          const marked = await store.compareAndUpdateDoc<SvgMedia>(`${paths.media(orgId, siteId)}/${media.id}`,
            current => current.storage?.key === location.key && current.sha256 === media.sha256,
            { svg_sanitized: { source_sha256: sha256(raw), sha256: sha256(raw), removed: [] } });
          if (!marked) { report.skipped.push({ media_id: media.id, reason: 'changed concurrently: run again' }); continue; }
        }
        report.unchanged++; continue;
      }
      const digest = sha256(bytes);
      if (options.apply) {
        await r2.send(new PutObjectCommand({ Bucket: location.bucket, Key: key(digest), Body: bytes, ContentType: SVG_MEDIA_TYPE, CacheControl: 'private, no-store' }),
          { abortSignal: AbortSignal.timeout(30_000) });
        const updated = await store.compareAndUpdateDoc<SvgMedia>(`${paths.media(orgId, siteId)}/${media.id}`,
          current => current.storage?.key === location.key && current.sha256 === media.sha256,
          { storage: { ...location, key: key(digest) }, r2_key: key(digest), sha256: digest, size_bytes: bytes.length, mime_type: SVG_MEDIA_TYPE,
            svg_sanitized: { source_sha256: sha256(raw), sha256: digest, removed } });
        if (!updated) { report.skipped.push({ media_id: media.id, reason: 'changed concurrently: run again' }); continue; }
      }
      report.sanitized.push({ media_id: media.id, removed, previous_sha256: media.sha256, sha256: digest });
    } finally { r2.destroy(); }
  }
  return report;
}
