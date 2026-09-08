import { createHash, randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { getConnection, connectionSummary, openCredentials, ConnectionError } from './connections';
import type { CloudflareCredentials } from './cloudflare-connection';

type Location = NonNullable<Media['storage']>;
const MAX_BYTES = 25 * 1024 * 1024;

function client(accountId: string, accessKeyId: string, secretAccessKey: string) {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !accessKeyId || !secretAccessKey) throw new ConnectionError('Media storage access is unavailable. Open Publishing to check the connection.', 503, 'media_storage_unavailable');
  return new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', maxAttempts: 2 });
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
  return client(location.account_id, process.env.R2_ACCESS_KEY_ID!, process.env.R2_SECRET_ACCESS_KEY!);
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

export async function createMediaUpload(orgId: string, siteId: string, input: { filename: string; contentType: string; size?: number; altText?: string; actor: string }) {
  if (typeof input.filename !== 'string' || !input.filename || input.filename.length > 255 || typeof input.contentType !== 'string' ||
      !/^(image\/[a-zA-Z0-9.+-]+|application\/pdf)$/.test(input.contentType)) throw new ConnectionError('Choose an image or PDF with a valid filename.', 415);
  if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_BYTES)) throw new ConnectionError('The file must be between 1 byte and 25 MB.', 413);
  const destination = await uploadDestination(orgId);
  const prefix = await siteMediaPrefix(orgId, siteId);
  const id = randomUUID();
  const key = `private/${prefix}/uploads/${id}/${input.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storage: Location = { ...destination, key, state: 'uploading', grant_expires_at: new Date(Date.now() + 300_000).toISOString() };
  const r2 = await storageClient(orgId, storage);
  try {
    const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket: storage.bucket, Key: key,
      ContentType: input.contentType, ...(input.size ? { ContentLength: input.size } : {}) }), { expiresIn: 300 });
    const base = process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, '');
    if (!base) throw new ConnectionError('The administrator must configure the public portal address.', 503);
    const cdnUrl = `${base}/api/sites/${encodeURIComponent(siteId)}/media/${id}/content`;
    await getStore().createDocIfMissing(`${paths.media(orgId, siteId)}/${id}`, {
      filename: input.filename, mime_type: input.contentType, size_bytes: input.size, alt_text: input.altText,
      uploaded_by: input.actor, created_at: new Date().toISOString(), cdn_url: cdnUrl, r2_key: key, storage,
    });
    return { uploadUrl, cdnUrl, key, mediaId: id, storage: destination.provider };
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
      await requestMediaMigration(orgId);
    }
    return { sha256: media.sha256, size_bytes: media.size_bytes, variants_generated: false, variant_count: 0, variants_pending: true };
  }
  const r2 = await storageClient(orgId, location);
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }), { abortSignal: AbortSignal.timeout(30_000) });
    if (!object.Body || !object.ETag || !object.ContentLength || object.ContentLength > MAX_BYTES || (media.size_bytes && media.size_bytes !== object.ContentLength)) throw new ConnectionError('The uploaded file has an unexpected size. Upload it again.', 422, 'media_integrity_failed');
    const bytes = await object.Body.transformToByteArray();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expectedSha256 && expectedSha256.toLowerCase() !== sha256) throw new ConnectionError('The stored image does not match expected_sha256. Upload it again.', 422, 'media_integrity_failed');
    const prefix = await siteMediaPrefix(orgId, siteId);
    const key = `private/${prefix}/originals/${sha256}/${media.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await r2.send(new CopyObjectCommand({ Bucket: location.bucket, Key: key, CopySource: `${location.bucket}/${location.key}`,
      CopySourceIfMatch: object.ETag, MetadataDirective: 'REPLACE', ContentType: media.mime_type, CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(30_000) });
    const changed = await store.compareAndUpdateDoc<Media>(path, current => current.storage?.generation === location.generation && current.storage?.key === location.key,
      { storage: { ...location, key, state: 'ready' }, r2_key: key, sha256, size_bytes: bytes.length });
    if (!changed) throw new ConnectionError('Media storage changed during upload verification. Retry finalizing the upload.', 409, 'media_revision_conflict');
    if (location.provider === 'draft_r2') {
      const { requestMediaMigration } = await import('./media-migration');
      await requestMediaMigration(orgId);
    }
    return { sha256, size_bytes: bytes.length, variants_generated: false, variant_count: 0, variants_pending: true };
  } finally { r2.destroy(); }
}

export async function privateMediaReadUrl(orgId: string, siteId: string, mediaId: string, ttlSeconds = 60) {
  const media = await getStore().getDoc<Media>(`${paths.media(orgId, siteId)}/${mediaId}`);
  if (!media?.storage || media.storage.state !== 'ready') throw new ConnectionError('The media upload is not ready.', 404);
  const r2 = await storageClient(orgId, media.storage);
  try {
    return await getSignedUrl(r2, new GetObjectCommand({ Bucket: media.storage.bucket, Key: media.storage.key,
      ResponseCacheControl: 'private, no-store', ResponseContentType: media.mime_type }), { expiresIn: Math.max(1, Math.min(60, ttlSeconds)) });
  } finally { r2.destroy(); }
}

export async function mediaUploadAvailability(orgId: string) {
  const destination = await uploadDestination(orgId);
  const r2 = await storageClient(orgId, destination);
  r2.destroy();
  return { enabled: true, storage: destination.provider };
}

/** Opaque editor frames cannot use session cookies for images. Resolve only the private media actually referenced in this render. */
export async function authorizePreviewMedia(html: string, orgId: string, siteId: string, ttlSeconds = 60) {
  const { replacePublicationReferences } = await import('./media-manifest');
  const media = await getStore().listDocs<Media>(paths.media(orgId, siteId));
  const replacements = new Map<string, string>();
  for (const item of media) {
    if (!item.storage || !html.includes(item.cdn_url)) continue;
    if (item.storage.state !== 'ready') continue;
    replacements.set(item.cdn_url, await privateMediaReadUrl(orgId, siteId, item.id, ttlSeconds));
  }
  return replacePublicationReferences(html, replacements);
}
