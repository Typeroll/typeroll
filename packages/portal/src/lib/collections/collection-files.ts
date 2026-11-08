// The files of the organization collection: the media (and, for a whole
// package kept as one entry, the font files) its entries carry.
//
// An entry's package names each file by path and sha256
// (`package.integrity.files`); the bytes are stored once per organization,
// keyed by sha256, so entries that use the same image share one file. They
// live in the organization's private storage like the Fonts library
// (lib/fonts/font-storage.ts): the organization's own R2 bucket once it is
// media ready, the platform's private bucket before that, and the datastore
// (in chunks beneath the file's record) on a portal without either, as in
// local development and the E2E Worker. No public URL points at them; the
// portal serves previews to signed-in members.
//
// A file no entry references is removed when an entry is deleted
// (collectGarbage). A file stored or reused in the last few minutes is kept,
// so an entry being saved at that moment never loses a file it is about to
// reference.

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getStore } from '../datastore';
import { fontStorageDestination, sha256Hex, type FontStorage } from '../fonts/font-storage';
import { storageClient } from '../publishing/media-storage';

export interface CollectionFileRecord {
  sha256: string;
  bytes: number;
  content_type: string;
  storage: FontStorage;
  key: string;
  created_at: string;
  /** Last stored or reused; garbage collection keeps recent files. */
  used_at: string;
}

/** Reads and writes collection files; the default uses the organization's private storage. */
export interface CollectionFileIO {
  put(orgId: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(orgId: string, sha256: string): Promise<Uint8Array>;
  remove(orgId: string, sha256: string): Promise<void>;
  list(orgId: string): Promise<Array<{ sha256: string; used_at: string }>>;
}

const CHUNK_BYTES = 768 * 1024;
const TIMEOUT_MS = 30_000;
/** Files touched more recently than this are never collected. */
export const COLLECTION_FILE_GRACE_MS = 10 * 60 * 1000;
const SHA = /^[a-f0-9]{64}$/;

export const collectionFilePaths = {
  files: (orgId: string) => `organizations/${orgId}/collection_files`,
  file: (orgId: string, sha: string) => `organizations/${orgId}/collection_files/${sha}`,
  chunks: (orgId: string, sha: string) => `organizations/${orgId}/collection_files/${sha}/bytes`,
};

export class CollectionFileError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'CollectionFileError'; }
}

async function putObject(orgId: string, sha: string, storage: FontStorage, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (storage.provider === 'datastore') {
    const store = getStore();
    const count = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
    for (let index = 0; index < count; index++) {
      const part = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      await store.setDoc(`${collectionFilePaths.chunks(orgId, sha)}/${String(index).padStart(4, '0')}`, { index, count, data: Buffer.from(part).toString('base64') });
    }
    return;
  }
  const r2 = await storageClient(orgId, storage);
  try {
    await r2.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  } finally { r2.destroy(); }
}

async function getObject(orgId: string, record: CollectionFileRecord): Promise<Uint8Array> {
  if (record.storage.provider === 'datastore') {
    const chunks = (await getStore().listDocs<{ index: number; count: number; data: string }>(collectionFilePaths.chunks(orgId, record.sha256)))
      .sort((a, b) => a.index - b.index);
    if (!chunks.length || chunks.length !== chunks[0]!.count || chunks.some((chunk, index) => chunk.index !== index)) throw new Error('the stored file is missing or incomplete');
    return new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64'))));
  }
  const storage = record.storage;
  const r2 = await storageClient(orgId, storage);
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: storage.bucket, Key: record.key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!object.Body) throw new Error('the stored file is missing');
    return await object.Body.transformToByteArray();
  } finally { r2.destroy(); }
}

export const defaultCollectionFileIO: CollectionFileIO = {
  async put(orgId, bytes, contentType) {
    const sha = sha256Hex(bytes);
    const store = getStore();
    const path = collectionFilePaths.file(orgId, sha);
    const now = new Date().toISOString();
    const existing = await store.getDoc<CollectionFileRecord>(path);
    if (existing) { await store.updateDoc(path, { used_at: now }); return sha; }
    const storage = await fontStorageDestination(orgId);
    // Per organization even in the platform's shared private bucket.
    const key = `private/collection/${orgId}/${sha}`;
    await putObject(orgId, sha, storage, key, bytes, contentType);
    const record: CollectionFileRecord = { sha256: sha, bytes: bytes.byteLength, content_type: contentType, storage, key, created_at: now, used_at: now };
    // A concurrent save of the same bytes wrote the same content-addressed object.
    if (!await store.createDocIfMissing(path, record as unknown as Record<string, unknown>)) await store.updateDoc(path, { used_at: now });
    return sha;
  },

  async get(orgId, sha) {
    if (!SHA.test(sha)) throw new CollectionFileError('Unknown collection file', 404);
    const record = await getStore().getDoc<CollectionFileRecord>(collectionFilePaths.file(orgId, sha));
    if (!record) throw new CollectionFileError(`A file of this collection entry (${sha.slice(0, 12)}…) is missing`, 409);
    let bytes: Uint8Array;
    try { bytes = await getObject(orgId, record); }
    catch (error) { throw new CollectionFileError(`A file of this collection entry could not be read: ${error instanceof Error ? error.message : 'unavailable'}`, 409); }
    if (sha256Hex(bytes) !== sha) throw new CollectionFileError('A file of this collection entry does not match its sha256', 409);
    return bytes;
  },

  async remove(orgId, sha) {
    if (!SHA.test(sha)) return;
    const store = getStore();
    const path = collectionFilePaths.file(orgId, sha);
    const record = await store.getDoc<CollectionFileRecord>(path);
    if (!record) return;
    if (record.storage.provider !== 'datastore') {
      const storage = record.storage;
      const r2 = await storageClient(orgId, storage).catch(() => null);
      if (r2) {
        try {
          await r2.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: record.key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) })
            .catch(error => console.warn(JSON.stringify({ event: 'collection_file_delete_failed', sha256: sha, error: error instanceof Error ? error.message : String(error) })));
        } finally { r2.destroy(); }
      }
    }
    // The record and its datastore chunks beneath it.
    await store.deleteTree(path);
  },

  async list(orgId) {
    const records = await getStore().listDocs<CollectionFileRecord>(collectionFilePaths.files(orgId));
    return records.map(record => ({ sha256: record.sha256 ?? record.id, used_at: record.used_at ?? record.created_at ?? '' }));
  },
};

/** Remove the files no entry references, except those touched within the grace period. */
export async function collectGarbage(orgId: string, referenced: ReadonlySet<string>, io: CollectionFileIO = defaultCollectionFileIO, now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  for (const file of await io.list(orgId)) {
    if (referenced.has(file.sha256)) continue;
    const used = Date.parse(file.used_at);
    if (Number.isFinite(used) && now - used < COLLECTION_FILE_GRACE_MS) continue;
    await io.remove(orgId, file.sha256);
    removed.push(file.sha256);
  }
  return removed;
}
