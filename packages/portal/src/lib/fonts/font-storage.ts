// Where the bytes of the site's Fonts library live.
//
// Font files are private: the portal serves them to signed-in editors
// (`/api/sites/{siteId}/fonts/{fontId}/file`) and a publication copies them
// into the frozen site, but no public URL ever points at the stored object.
// They therefore use the organization's private media storage, never the
// legacy public media bucket, where every key is public:
//
//   organization_r2  the organization's own R2 bucket once it is media ready
//                    (the same destination private media uploads use);
//   draft_r2         the platform's private bucket (R2_PRIVATE_BUCKET) before
//                    that. The object stays there when the organization later
//                    connects its own R2: the font document records the
//                    location, so reads keep working, and new uploads go to
//                    the organization's bucket;
//   datastore        a portal without any private bucket (self-hosting without
//                    R2, local development and the E2E Worker) keeps the bytes
//                    in the datastore, beneath the font document, in chunks
//                    that fit the store's document limit. Font files are
//                    small (10 MB at most, usually far less), and a site has
//                    at most MAX_SITE_FONT_FILES of them.
//
// Keys are content addressed (`private/<site media prefix>/fonts/<sha256>.woff2`
// and `.../fonts/originals/<sha256>.<ext>`), so a retried upload writes the
// same object again.

import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getConnection } from '../publishing/connections';
import { storageClient } from '../publishing/media-storage';

export type FontStorage =
  | { provider: 'organization_r2' | 'draft_r2'; account_id: string; bucket: string }
  | { provider: 'datastore' };

/** Raw bytes per datastore chunk: about 1 MB as base64, under the 1.9 MB document limit. */
export const FONT_CHUNK_BYTES = 768 * 1024;
const TIMEOUT_MS = 30_000;

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The destination for a new upload: the organization's private media storage, else the datastore. */
export async function fontStorageDestination(orgId: string): Promise<FontStorage> {
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.media_ready && connection.cloudflare?.account_id && connection.cloudflare.bucket) {
    return { provider: 'organization_r2', account_id: connection.cloudflare.account_id, bucket: connection.cloudflare.bucket };
  }
  const privateBucket = process.env.R2_PRIVATE_BUCKET?.trim();
  if (privateBucket && privateBucket !== process.env.R2_BUCKET?.trim() && process.env.R2_ACCOUNT_ID) {
    return { provider: 'draft_r2', account_id: process.env.R2_ACCOUNT_ID, bucket: privateBucket };
  }
  return { provider: 'datastore' };
}

const chunkCollection = (orgId: string, siteId: string, fontId: string) => `${paths.font(orgId, siteId, fontId)}/bytes`;
const chunkPrefix = (key: string) => sha256Hex(new TextEncoder().encode(key)).slice(0, 16);

/** Store one object. */
export async function putFontObject(orgId: string, siteId: string, fontId: string, storage: FontStorage, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (storage.provider === 'datastore') {
    const store = getStore(), prefix = chunkPrefix(key);
    const count = Math.max(1, Math.ceil(bytes.byteLength / FONT_CHUNK_BYTES));
    for (let index = 0; index < count; index++) {
      const part = bytes.subarray(index * FONT_CHUNK_BYTES, (index + 1) * FONT_CHUNK_BYTES);
      await store.setDoc(`${chunkCollection(orgId, siteId, fontId)}/${prefix}-${String(index).padStart(3, '0')}`, {
        key, index, count, data: Buffer.from(part).toString('base64'),
      });
    }
    return;
  }
  const r2 = await storageClient(orgId, storage);
  try {
    await r2.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  } finally { r2.destroy(); }
}

/** Read one object; throws when it is missing. */
export async function getFontObject(orgId: string, siteId: string, fontId: string, storage: FontStorage, key: string): Promise<Uint8Array> {
  if (storage.provider === 'datastore') {
    const prefix = chunkPrefix(key);
    const chunks = (await getStore().listDocs<{ key: string; index: number; count: number; data: string }>(chunkCollection(orgId, siteId, fontId)))
      .filter(chunk => chunk.id.startsWith(`${prefix}-`) && chunk.key === key)
      .sort((a, b) => a.index - b.index);
    if (!chunks.length || chunks.length !== chunks[0]!.count || chunks.some((chunk, index) => chunk.index !== index)) throw new Error(`Font file ${key} is missing or incomplete`);
    return new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64'))));
  }
  const r2 = await storageClient(orgId, storage);
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!object.Body) throw new Error(`Font file ${key} is missing`);
    return await object.Body.transformToByteArray();
  } finally { r2.destroy(); }
}

/**
 * Remove the stored R2 objects of a font. Best effort: a leftover object is
 * private and content addressed. Datastore chunks live beneath the font
 * document and go with it (`deleteTree` on the font).
 */
export async function deleteFontObjects(orgId: string, storage: FontStorage, keys: string[]): Promise<void> {
  if (storage.provider === 'datastore') return;
  const r2 = await storageClient(orgId, storage);
  try {
    for (const key of keys) {
      await r2.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) })
        .catch(error => console.warn(JSON.stringify({ event: 'font_object_delete_failed', key, error: error instanceof Error ? error.message : String(error) })));
    }
  } finally { r2.destroy(); }
}
