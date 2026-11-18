import { organizationUploadTtl } from '../organization-access';
import { remoteTransfersEnabled, verifyWithTransferService, type TransferReceipt } from '../media/remote-transfer';
import { createHash, randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, getSignedUrl } from '../net/s3';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { getConnection, connectionSummary, openCredentials, ConnectionError } from './connections';
import type { CloudflareCredentials } from './cloudflare-connection';
import { r2Endpoint } from '../r2-endpoint';

import { requiresSvgSanitization, withMediaExtension } from '../media/file-types';

type Location = NonNullable<Media['storage']>;
const MAX_BYTES = 25 * 1024 * 1024;

function client(accountId: string, accessKeyId: string, secretAccessKey: string, bucket?: string) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !accessKeyId || !secretAccessKey) throw new ConnectionError('Media storage access is unavailable. Open Publishing to check the connection.', 503, 'media_storage_unavailable');
  return new S3Client({ region: 'auto', endpoint: r2Endpoint(accountId, bucket),
    credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true, maxAttempts: 2 });
}

/** Resolve the recorded destination, including uploads granted before an organization connected R2. */
export async function storageClient(orgId: string, location: Pick<Location, 'provider' | 'account_id' | 'bucket'>) {
  if (location.provider === 'organization_r2') {
    const connection = await getConnection(orgId, 'cloudflare');
    if (!connectionSummary(connection).media_ready || connection.cloudflare?.account_id !== location.account_id ||
        connection.cloudflare?.bucket !== location.bucket || !connection.encrypted_credentials) {
      throw new ConnectionError('Reconnect the organization’s original R2 storage in Publishing. New uploads cannot fall back to another account.', 409, 'media_storage_unavailable');
    }
    const credentials = openCredentials<CloudflareCredentials>(orgId, 'cloudflare', connection.encrypted_credentials);
    return client(location.account_id, credentials.access_key_id, credentials.secret_access_key);
  }
  if (location.account_id !== process.env.R2_ACCOUNT_ID || location.bucket !== process.env.R2_PRIVATE_BUCKET || !location.bucket) {
    throw new ConnectionError('Private draft storage is unavailable. Contact the administrator.', 503, 'draft_storage_unavailable');
  }
  return client(location.account_id, process.env.R2_ACCESS_KEY_ID!, process.env.R2_SECRET_ACCESS_KEY!, location.bucket);
}

async function uploadDestination(orgId: string) {
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.media_ready) {
    // This remains sticky through disconnects. A failed customer connection never changes ownership back to the publisher.
    return { provider: 'organization_r2' as const, account_id: connection.cloudflare!.account_id,
      bucket: connection.cloudflare!.bucket, generation: connection.revision };
  }
  if (!process.env.R2_PRIVATE_BUCKET || process.env.R2_PRIVATE_BUCKET === process.env.R2_BUCKET) {
    throw new ConnectionError('Private draft storage is unavailable. Contact the administrator.', 503, 'draft_storage_unavailable');
  }
  return { provider: 'draft_r2' as const, account_id: process.env.R2_ACCOUNT_ID!, bucket: process.env.R2_PRIVATE_BUCKET,
    generation: connection.revision };
}

/**
 * Media people can upload: images, PDFs and web-ready video (MP4, WebM). Video
 * follows the same 25 MB limit as everything else, because publication reads
 * each file whole; a phone original is prepared to fit first (Advanced Design).
 */
export const UPLOADABLE_MEDIA_TYPE = /^(image\/[a-zA-Z0-9.+-]+|application\/pdf|video\/mp4|video\/webm)$/;

export async function createMediaUpload(orgId: string, siteId: string, input: { filename: string; contentType: string; size?: number; altText?: string; actor: string }) {
  if (typeof input.filename !== 'string' || !input.filename || input.filename.length > 255 || typeof input.contentType !== 'string' ||
      !UPLOADABLE_MEDIA_TYPE.test(input.contentType)) throw new ConnectionError('Choose an image, PDF or MP4 or WebM video with a valid filename.', 415);
  // Static hosts serve a file by its extension: a name without the type's
  // extension gets it appended (415 for a type that cannot be published).
  const filename = withMediaExtension(input.filename, input.contentType);
  if (filename.length > 255) throw new ConnectionError('Choose an image, PDF or MP4 or WebM video with a valid filename.', 415);
  if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_BYTES)) throw new ConnectionError('The file must be between 1 byte and 25 MB.', 413);
  const uploadTtl = await organizationUploadTtl(orgId);
  const destination = await uploadDestination(orgId);
  const prefix = await siteMediaPrefix(orgId, siteId);
  const id = randomUUID();
  const key = `private/${prefix}/uploads/${id}/${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storage: Location = { ...destination, key, state: 'uploading', grant_expires_at: new Date(Date.now() + uploadTtl * 1000).toISOString() };
  const r2 = await storageClient(orgId, storage);
  try {
    const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket: storage.bucket, Key: key,
      ContentType: input.contentType, ...(input.size ? { ContentLength: input.size } : {}) }), { expiresIn: uploadTtl });
    const base = process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, '');
    if (!base) throw new ConnectionError('The administrator must configure the public portal address.', 503);
    const cdnUrl = `${base}/api/sites/${encodeURIComponent(siteId)}/media/${id}/content`;
    await getStore().createDocIfMissing(`${paths.media(orgId, siteId)}/${id}`, {
      filename, mime_type: input.contentType, size_bytes: input.size, alt_text: input.altText,
      uploaded_by: input.actor, created_at: new Date().toISOString(), cdn_url: cdnUrl, r2_key: key, storage,
    });
    return { uploadUrl, cdnUrl, key, mediaId: id, filename, storage: destination.provider, expiresIn: uploadTtl };
  } finally { r2.destroy(); }
}

/** Freeze the uploaded bytes into a different key so an unexpired PUT cannot mutate a finalized asset. */
export async function finalizeStoredMedia(orgId: string, siteId: string, mediaId: string, expectedSha256?: string) {
  const path = `${paths.media(orgId, siteId)}/${mediaId}`;
  const store = getStore();
  const media = await store.getDoc<Media>(path);
  if (!media?.storage) throw new ConnectionError('Media not found.', 404);
  const location = media.storage;
  if (location.state === 'ready' && media.sha256) {
    if (expectedSha256 && expectedSha256.toLowerCase() !== media.sha256) throw new ConnectionError('The stored image does not match expected_sha256.', 422, 'media_integrity_failed');
    if (location.provider === 'draft_r2') {
      const { requestMediaMigration } = await import('./media-migration');
      await requestMediaMigration(orgId, siteId);
    }
    const { requestMediaPreparation, QUEUED_PREPARATION } = await import('../media/preparation');
    const queued = await requestMediaPreparation(orgId, siteId, mediaId);
    return { sha256: media.sha256, size_bytes: media.size_bytes, variants_generated: false, variant_count: 0, variants_pending: /^image\//.test(media.mime_type ?? ''), ...(queued ? { preparation: QUEUED_PREPARATION } : {}) };
  }
  const r2 = await storageClient(orgId, location);
  try {
    let sha256: string, size: number, etag: string;
    if (await remoteTransfersEnabled(orgId)) {
      const receipt = await verifyWithTransferService(orgId, r2, location.bucket, location.key, expectedSha256, media.size_bytes);
      ({ sha256, size, etag } = receipt);
    } else {
      const object = await r2.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }), { abortSignal: AbortSignal.timeout(30_000) });
      if (!object.Body || !object.ETag || !object.ContentLength || object.ContentLength > MAX_BYTES || (media.size_bytes && media.size_bytes !== object.ContentLength)) throw new ConnectionError('The uploaded file has an unexpected size. Upload it again.', 422, 'media_integrity_failed');
      const bytes = await object.Body.transformToByteArray();
      sha256 = createHash('sha256').update(bytes).digest('hex'); size = bytes.length; etag = object.ETag;
      if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) throw new ConnectionError('The stored image does not match expected_sha256. Upload it again.', 422, 'media_integrity_failed');
    }
    return await freezeVerifiedMedia(orgId, siteId, mediaId, r2, media, { sha256, size, etag });
  } finally { r2.destroy(); }
}

/** Internal importer entry point: callers must obtain the receipt from the authenticated transfer service. */
export async function finalizeTransferredMedia(orgId: string, siteId: string, mediaId: string, receipt: TransferReceipt) {
  const media = await getStore().getDoc<Media>(`${paths.media(orgId, siteId)}/${mediaId}`);
  if (!media?.storage || media.storage.state !== 'uploading') throw new ConnectionError('Media upload changed before transfer completed.', 409, 'media_revision_conflict');
  const r2 = await storageClient(orgId, media.storage);
  try { return await freezeVerifiedMedia(orgId, siteId, mediaId, r2, media, receipt); }
  finally { r2.destroy(); }
}
async function freezeVerifiedMedia(orgId: string, siteId: string, mediaId: string, r2: S3Client, media: Media, { sha256, size, etag }: Pick<TransferReceipt, 'sha256' | 'size' | 'etag'>) {
  const location = media.storage!, store = getStore(), path = `${paths.media(orgId, siteId)}/${mediaId}`;
    // SVG is frozen only as the exact bytes the sanitizer wrote (lib/media/svg-media.ts).
    if (requiresSvgSanitization(media) && (media as Media & { svg_sanitized?: { sha256?: string } }).svg_sanitized?.sha256 !== sha256) {
      throw new ConnectionError('This SVG has not been sanitized. Finalize it through the media finalize endpoint so it can be made safe.', 409, 'media_svg_unsanitized');
    }
    const prefix = await siteMediaPrefix(orgId, siteId);
    const key = `private/${prefix}/originals/${sha256}/${media.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await r2.send(new CopyObjectCommand({ Bucket: location.bucket, Key: key, CopySource: `${location.bucket}/${location.key}`,
      CopySourceIfMatch: etag, MetadataDirective: 'REPLACE', ContentType: media.mime_type, CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(30_000) });
    const changed = await store.compareAndUpdateDoc<Media>(path, current => current.storage?.generation === location.generation && current.storage?.key === location.key,
      { storage: { ...location, key, state: 'ready' }, r2_key: key, sha256, size_bytes: size });
    if (!changed) throw new ConnectionError('Media storage changed during upload verification. Retry finalizing the upload.', 409, 'media_revision_conflict');
    if (location.provider === 'draft_r2') {
      const { requestMediaMigration } = await import('./media-migration');
      await requestMediaMigration(orgId, siteId);
    }
    const { requestMediaPreparation, QUEUED_PREPARATION } = await import('../media/preparation');
    const queued = await requestMediaPreparation(orgId, siteId, mediaId);
    return { sha256, size_bytes: size, variants_generated: false, variant_count: 0, variants_pending: /^image\//.test(media.mime_type ?? ''), ...(queued ? { preparation: QUEUED_PREPARATION } : {}) };
}

/** The widths the build engine prepares below an image's own width (media recipe v2), plus the original. */
export const PREPARED_VARIANT_WIDTHS = [320, 640, 1024, 1920];
const PREPARED_RECIPE = 'v2';

/**
 * The prepared variants of a private image, as `slot` (`w640`, `original`) and
 * rendered width, or null when it has none yet. They exist once background
 * preparation has handled the image's current bytes with the current recipe.
 */
export function preparedVariantSlots(media: Media): Array<{ slot: string; width: number }> | null {
  const width = media.width ?? media.prepared_width;
  if (media.storage?.provider !== 'organization_r2' || media.storage.state !== 'ready' || !media.sha256 || !width || !Number.isSafeInteger(width) || width < 1) return null;
  if (media.preparation?.state !== 'ready' || media.preparation.recipe !== PREPARED_RECIPE || media.preparation.source_sha256 !== media.sha256) return null;
  return [...PREPARED_VARIANT_WIDTHS.filter(candidate => candidate < width).map(candidate => ({ slot: `w${candidate}`, width: candidate })), { slot: 'original', width }];
}

/**
 * The width of a prepared image that was stored without dimensions, read once
 * from the receipt the build engine wrote beside its prepared original and
 * kept on the media record. No image is processed; null when there is no
 * valid receipt for the image's current bytes.
 */
export async function preparedSourceWidth(orgId: string, siteId: string, media: Media & { id: string }): Promise<number | null> {
  if (media.width || media.prepared_width) return media.width ?? media.prepared_width ?? null;
  if (media.storage?.provider !== 'organization_r2' || media.storage.state !== 'ready' || !media.sha256 ||
    media.preparation?.state !== 'ready' || media.preparation.recipe !== PREPARED_RECIPE || media.preparation.source_sha256 !== media.sha256) return null;
  const key = `private/${await siteMediaPrefix(orgId, siteId)}/prepared/${PREPARED_RECIPE}/${media.sha256}/original.webp.receipt.json`;
  const r2 = await storageClient(orgId, media.storage);
  let width: unknown;
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: media.storage.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
    const bytes = object.Body ? await object.Body.transformToByteArray() : null;
    if (!bytes || bytes.length > 8192) return null;
    const receipt = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (receipt?.source_sha256 !== media.sha256 || receipt.format !== 'webp') return null;
    width = receipt.width;
  } catch { return null; } finally { r2.destroy(); }
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1 || width > 100_000) return null;
  await getStore().compareAndUpdateDoc<Media>(`${paths.media(orgId, siteId)}/${media.id}`, current => current.sha256 === media.sha256, { prepared_width: width }).catch(() => {});
  return width;
}

/**
 * A short-lived signed URL for a private media item, or for one of its
 * prepared variants (`w640.avif`, `original.webp`). `cacheSeconds` lets the
 * browser keep the file that long (a review preview), never past `ttlSeconds`.
 */
export async function privateMediaReadUrl(orgId: string, siteId: string, mediaId: string, ttlSeconds = 60, options: { variant?: string; cacheSeconds?: number } = {}) {
  const media = await getStore().getDoc<Media>(`${paths.media(orgId, siteId)}/${mediaId}`);
  return privateMediaReadUrlForRecord(orgId, siteId, media, ttlSeconds, options);
}

/** The caller already read this record from the authorized site's media collection. */
async function privateMediaReadUrlForRecord(orgId: string, siteId: string, media: (Media & { id: string }) | null, ttlSeconds: number, options: { variant?: string; cacheSeconds?: number } = {}) {
  if (!media?.storage || media.storage.state !== 'ready') throw new ConnectionError('The media upload is not ready.', 404);
  let key = media.storage.key, contentType = media.mime_type;
  if (options.variant !== undefined) {
    const match = /^(w\d{3,4}|original)\.(avif|webp)$/.exec(options.variant);
    if (!match || !preparedVariantSlots(media)?.some(entry => entry.slot === match[1])) throw new ConnectionError('This media variant is not prepared.', 404, 'media_variant_unavailable');
    key = `private/${await siteMediaPrefix(orgId, siteId)}/prepared/${PREPARED_RECIPE}/${media.sha256}/${match[1]}.${match[2]}`;
    contentType = `image/${match[2]}`;
  }
  const cache = Math.max(0, Math.min(3600, Math.floor(options.cacheSeconds ?? 0), ttlSeconds - 60));
  const r2 = await storageClient(orgId, media.storage);
  try {
    return await getSignedUrl(r2, new GetObjectCommand({ Bucket: media.storage.bucket, Key: key,
      ResponseCacheControl: cache ? `private, max-age=${cache}` : 'private, no-store', ResponseContentType: contentType }),
      { expiresIn: Math.max(1, cache ? cache + 60 : Math.min(60, ttlSeconds)) });
  } finally { r2.destroy(); }
}

export async function mediaUploadAvailability(orgId: string) {
  const uploadTtl = await organizationUploadTtl(orgId);
  const destination = await uploadDestination(orgId);
  const r2 = await storageClient(orgId, destination);
  r2.destroy();
  return { enabled: true, storage: destination.provider, expiresIn: uploadTtl };
}

/** Opaque editor frames cannot use session cookies for images. Resolve only the private media actually referenced in this render. */
export async function authorizePreviewMedia(html: string, orgId: string, siteId: string, ttlSeconds = 60) {
  const { replacePublicationReferences, privateMediaReferences } = await import('./media-manifest');
  const references = privateMediaReferences(html).filter(reference => reference.siteId === siteId);
  const replacements = new Map<string, string>();
  // Bound concurrency; signing URLs never downloads or transforms image bytes.
  // Read each media record once, even when the page uses it more than once.
  const ids = [...new Set(references.map(reference => reference.mediaId))];
  for (let offset = 0; offset < ids.length; offset += 4) {
    await Promise.all(ids.slice(offset, offset + 4).map(async id => {
      const item = await getStore().getDoc<Media>(`${paths.media(orgId, siteId)}/${id}`);
      if (!item?.storage || item.storage.state !== 'ready' || !html.includes(item.cdn_url)) return;
      replacements.set(item.cdn_url, await privateMediaReadUrlForRecord(orgId, siteId, item, ttlSeconds));
    }));
  }
  return replacePublicationReferences(html, replacements);
}
