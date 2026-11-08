// Temporary package downloads for the v1 API and MCP.
//
// An agent cannot receive a large zip in a JSON answer, so the v1 export
// stores the package for one hour and answers with a signed download URL.
// The bytes go where the Fonts library keeps its files (font-storage.ts): the
// organization's private R2 storage, the platform's private bucket, or, on a
// portal without either, the datastore in chunks beneath the download record.
//
// The URL carries an HMAC token (the preview-signing pattern, with its own
// purpose prefix so a preview token can never open a download and the other
// way round). It names the organization, site and download and expires with
// the stored file. Expired downloads are removed when the site next exports;
// nothing runs in the background.

import crypto, { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '../net/s3';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { storageClient } from '../publishing/media-storage';
import { fontStorageDestination, type FontStorage } from '../fonts/font-storage';
import { PackageError } from './package-zip';

export const PACKAGE_DOWNLOAD_TTL_SECONDS = 60 * 60;
const PURPOSE = 'typeroll-package-download.v1';
const CHUNK_BYTES = 768 * 1024;
const TIMEOUT_MS = 60_000;

interface DownloadRecord {
  filename: string;
  bytes: number;
  sha256: string;
  key: string;
  storage: FontStorage;
  created_at: string;
  expires_at: string;
}

const downloadsPath = (orgId: string, siteId: string) => `${paths.site(orgId, siteId)}/package_downloads`;
const downloadPath = (orgId: string, siteId: string, id: string) => `${downloadsPath(orgId, siteId)}/${id}`;

function secret(): string {
  const value = process.env.PREVIEW_HMAC_SECRET;
  if (!value || value.length < 32) throw new PackageError('Package downloads are not configured on this portal (PREVIEW_HMAC_SECRET)', 503, 'package_download_expired');
  return value;
}

const sign = (payload: string) => crypto.createHmac('sha256', secret()).update(`${PURPOSE}.${payload}`).digest('base64url');

export function signPackageDownload(ticket: { org_id: string; site_id: string; id: string; exp: number }): string {
  const payload = Buffer.from(JSON.stringify({ p: PURPOSE, ...ticket }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The ticket of a valid, unexpired token, or null. */
export function verifyPackageDownload(token: string | undefined | null): { org_id: string; site_id: string; id: string; exp: number } | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot), signature = token.slice(dot + 1);
  let expected: string;
  try { expected = sign(payload); } catch { return null; }
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (ticket.p !== PURPOSE || typeof ticket.org_id !== 'string' || typeof ticket.site_id !== 'string' || typeof ticket.id !== 'string' || typeof ticket.exp !== 'number') return null;
    if (ticket.exp * 1000 < Date.now()) return null;
    return { org_id: ticket.org_id, site_id: ticket.site_id, id: ticket.id, exp: ticket.exp };
  } catch { return null; }
}

async function putObject(orgId: string, siteId: string, id: string, storage: FontStorage, key: string, bytes: Uint8Array): Promise<void> {
  if (storage.provider === 'datastore') {
    const store = getStore();
    const count = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
    for (let index = 0; index < count; index++) {
      await store.setDoc(`${downloadPath(orgId, siteId, id)}/bytes/${String(index).padStart(4, '0')}`, {
        index, count, data: Buffer.from(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)).toString('base64'),
      });
    }
    return;
  }
  const r2 = await storageClient(orgId, storage);
  try {
    await r2.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes, ContentType: 'application/vnd.typeroll.package+zip', CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  } finally { r2.destroy(); }
}

async function getObject(orgId: string, siteId: string, id: string, record: DownloadRecord): Promise<Uint8Array> {
  if (record.storage.provider === 'datastore') {
    const chunks = (await getStore().listDocs<{ index: number; count: number; data: string }>(`${downloadPath(orgId, siteId, id)}/bytes`)).sort((a, b) => a.index - b.index);
    if (!chunks.length || chunks.length !== chunks[0]!.count) throw new Error('The stored package is incomplete');
    return new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64'))));
  }
  const storage = record.storage;
  const r2 = await storageClient(orgId, storage);
  try {
    const object = await r2.send(new GetObjectCommand({ Bucket: storage.bucket, Key: record.key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!object.Body) throw new Error('The stored package is missing');
    return await object.Body.transformToByteArray();
  } finally { r2.destroy(); }
}

async function removeDownload(orgId: string, siteId: string, id: string, record: DownloadRecord): Promise<void> {
  if (record.storage.provider !== 'datastore') {
    const storage = record.storage;
    const r2 = await storageClient(orgId, storage).catch(() => null);
    if (r2) try { await r2.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: record.key }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {}); } finally { r2.destroy(); }
  }
  await getStore().deleteTree(downloadPath(orgId, siteId, id));
}

/** Remove this site's expired downloads. Best effort. */
async function sweepExpired(orgId: string, siteId: string): Promise<void> {
  const now = Date.now();
  for (const record of await getStore().listDocs<DownloadRecord>(downloadsPath(orgId, siteId)).catch(() => [])) {
    if (Date.parse(record.expires_at) < now) await removeDownload(orgId, siteId, record.id, record).catch(() => {});
  }
}

/** Store a package for an hour; returns a signed URL path and when it expires. */
export async function storePackageDownload(orgId: string, siteId: string, input: { zip: Uint8Array; filename: string; sha256: string }): Promise<{ token: string; expires_at: string }> {
  secret();
  await sweepExpired(orgId, siteId);
  const id = randomUUID();
  const storage = await fontStorageDestination(orgId);
  const prefix = await siteMediaPrefix(orgId, siteId);
  const key = `private/${prefix}/packages/${id}.typeroll`;
  await putObject(orgId, siteId, id, storage, key, input.zip);
  const exp = Math.floor(Date.now() / 1000) + PACKAGE_DOWNLOAD_TTL_SECONDS;
  const record: DownloadRecord = {
    filename: input.filename, bytes: input.zip.byteLength, sha256: input.sha256, key, storage,
    created_at: new Date().toISOString(), expires_at: new Date(exp * 1000).toISOString(),
  };
  await getStore().setDoc(downloadPath(orgId, siteId, id), record as unknown as Record<string, unknown>);
  return { token: signPackageDownload({ org_id: orgId, site_id: siteId, id, exp }), expires_at: record.expires_at };
}

/** The stored package a token opens for this site, or null. */
export async function readPackageDownload(token: string | undefined, siteId: string | undefined): Promise<{ bytes: Uint8Array; filename: string; sha256: string } | null> {
  const ticket = verifyPackageDownload(token);
  if (!ticket || ticket.site_id !== siteId) return null;
  const record = await getStore().getDoc<DownloadRecord>(downloadPath(ticket.org_id, ticket.site_id, ticket.id));
  if (!record || Date.parse(record.expires_at) < Date.now()) return null;
  const bytes = await getObject(ticket.org_id, ticket.site_id, ticket.id, record);
  return { bytes, filename: record.filename, sha256: record.sha256 };
}

export function packageDownloadUrl(request: Request, siteId: string, token: string): string {
  const base = process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, '') || new URL(request.url).origin;
  return `${base}/api/v1/sites/${encodeURIComponent(siteId)}/packages/downloads/${token}`;
}
