// Media bytes for packages: reading a site's files into a package, and
// adding a package's files to a site's Media library.
//
// Adding goes through the normal private media path, exactly like an upload
// from the portal: createMediaUpload reserves the record and the private
// object key in the organization's storage, the bytes are written to that key
// here on the server (instead of by the browser with the signed URL), and
// finalizeOrganizationMedia verifies the sha256, sanitizes SVG and freezes the
// object, after which variants are prepared as for any upload.
//
// Reading uses the record's private storage location. A legacy public file
// without one is fetched from its public address over HTTPS.

import { GetObjectCommand, PutObjectCommand } from '../net/s3';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { createMediaUpload, storageClient, UPLOADABLE_MEDIA_TYPE } from '../publishing/media-storage';
import { finalizeOrganizationMedia } from '../media/svg-media';
import { createSafeFetch } from '../net/safe-fetch';
import { deleteMediaObjects } from '../media-deletion';
import { PackageError, sha256Hex } from './package-zip';

/** The largest file the Media library accepts (media-storage.ts). */
export const MAX_SITE_MEDIA_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface StoreMediaInput {
  bytes: Uint8Array;
  sha256: string;
  filename: string;
  contentType: string;
  altText?: string;
  title?: string;
  width?: number;
  height?: number;
  demo?: boolean;
  /** Recorded on the media document: which package and file it came from. */
  source: { package_id: string; package_version: string; media_id: string };
  actor: string;
}

/** Reads and writes media bytes; the default uses the organization's private storage. */
export interface PackageMediaIO {
  read(orgId: string, siteId: string, media: Media): Promise<Uint8Array>;
  store(orgId: string, siteId: string, input: StoreMediaInput): Promise<{ id: string; cdn_url: string }>;
}

/** Whether the Media library accepts a file of this type and size. */
export function mediaAcceptable(contentType: string, bytes: number): string | null {
  if (!UPLOADABLE_MEDIA_TYPE.test(contentType)) return `the Media library does not accept ${contentType} files`;
  if (bytes > MAX_SITE_MEDIA_BYTES) return `the file is larger than ${MAX_SITE_MEDIA_BYTES / 1024 / 1024} MB, the Media library's limit`;
  return null;
}

async function readPrivate(orgId: string, media: Media): Promise<Uint8Array> {
  const location = media.storage!;
  const r2 = await storageClient(orgId, location);
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!object.Body) throw new Error('empty object');
    return await object.Body.transformToByteArray();
  } finally { r2.destroy(); }
}

async function readPublic(media: Media): Promise<Uint8Array> {
  const url = media.cdn_url;
  if (!/^https:\/\//i.test(url ?? '')) throw new Error('the file has no private storage and no public https address');
  const guarded = createSafeFetch({ label: 'Media file', maxRedirects: 3, timeoutMs: TIMEOUT_MS, maxBytes: MAX_SITE_MEDIA_BYTES });
  const response = await guarded(url);
  if (!response.ok) throw new Error(`its address answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export const defaultPackageMediaIO: PackageMediaIO = {
  async read(orgId, _siteId, media) {
    try {
      const bytes = media.storage?.state === 'ready' ? await readPrivate(orgId, media) : await readPublic(media);
      if (media.sha256 && sha256Hex(bytes) !== media.sha256) throw new Error('the stored bytes do not match their sha256');
      return bytes;
    } catch (error) {
      throw new PackageError(`The media file ${media.filename} (${media.id}) could not be read: ${error instanceof Error ? error.message : 'unavailable'}`, 409, 'package_media_unavailable', { media_id: media.id });
    }
  },

  async store(orgId, siteId, input) {
    const upload = await createMediaUpload(orgId, siteId, {
      filename: input.filename, contentType: input.contentType, size: input.bytes.byteLength, altText: input.altText, actor: input.actor,
    });
    const path = `${paths.media(orgId, siteId)}/${upload.mediaId}`;
    const store = getStore();
    const record = await store.getDoc<Media>(path);
    if (!record?.storage) throw new PackageError('The media upload could not be reserved', 503, 'package_media_unavailable');
    try {
      const r2 = await storageClient(orgId, record.storage);
      try {
        await r2.send(new PutObjectCommand({
          Bucket: record.storage.bucket, Key: upload.key, Body: input.bytes, ContentType: input.contentType,
          ContentLength: input.bytes.byteLength, CacheControl: 'private, no-store',
        }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
      } finally { r2.destroy(); }
      await finalizeOrganizationMedia(orgId, siteId, upload.mediaId, input.sha256);
    } catch (error) {
      // A file that never became ready leaves no half-written record behind:
      // the import reports it as not written. The record stays only when its
      // objects could not be removed, so the bytes are never orphaned.
      const reserved = await store.getDoc<Media>(path).catch(() => null);
      const removed = reserved ? await deleteMediaObjects(orgId, reserved).catch(() => ({ failed: [{}] })) : { failed: [] };
      if (!removed.failed.length) await store.deleteDoc(path).catch(() => {});
      throw error;
    }
    await store.updateDoc(path, {
      ...(input.title ? { title: input.title } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.demo ? { demo: true } : {}),
      package_source: input.source,
    });
    return { id: upload.mediaId, cdn_url: upload.cdnUrl };
  },
};

export { mediaAddresses } from './demo-media';

/** A library file with these bytes, to reuse instead of uploading the same file again. */
export function findMediaBySha(library: readonly Media[], sha256: string): Media | undefined {
  return library.find(media => (media.sha256 === sha256 || (media as Media & { svg_sanitized?: { source_sha256?: string } }).svg_sanitized?.source_sha256 === sha256)
    && (!media.storage || media.storage.state === 'ready') && !!media.cdn_url);
}
