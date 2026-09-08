import { createHash, randomUUID } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { connectionSummary, getConnection, ConnectionError } from './connections';
import { getOrganizationDomains } from './domain-config';
import { storageClient } from './media-storage';
import { replacePublicationReferences } from './media-manifest';

const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const migrationPath = (orgId: string) => `publishing_media_migrations/${hash(orgId)}`;
interface Migration { org_id: string; state: 'queued' | 'running' | 'complete' | 'failed'; copied_files: number; copied_bytes: number; pending_files: number; lease_id: string | null; lease_until: number; error?: string | null; request_id?: string }

/** Zero counters also describe an unscanned job. Check the records before declaring it empty. */
async function completeEmptyMigration(orgId: string, current: Migration | null): Promise<Migration | null> {
  if (!current || current.state === 'complete' || current.lease_until > Date.now()) return current;
  const store = getStore();
  for (const site of await store.listDocs(paths.sites(orgId))) {
    if ((await store.listDocs<Media>(paths.media(orgId, site.id), { limit: 1 })).length) return current;
  }
  // A late upload queues a new request after finalization. Never overwrite that
  // request or a worker that acquired the lease while this scan was running.
  await store.compareAndUpdateDoc<Migration>(migrationPath(orgId),
    value => value.request_id === current.request_id && value.state === current.state &&
      value.lease_id === current.lease_id && value.lease_until <= Date.now(),
    { state: 'complete', pending_files: 0, lease_id: null, lease_until: 0, error: null, updated_at: new Date().toISOString() });
  return store.getDoc<Migration>(migrationPath(orgId));
}

export async function requestMediaMigration(orgId: string) {
  const [connection, domains] = await Promise.all([getConnection(orgId, 'cloudflare'), getOrganizationDomains(orgId)]);
  if (!connectionSummary(connection).media_ready || !domains.media_host) return;
  await getStore().createDocIfMissing(migrationPath(orgId), { org_id: orgId, state: 'queued', copied_files: 0, copied_bytes: 0, pending_files: 0, lease_id: null, lease_until: 0 });
  await getStore().compareAndUpdateDoc<Migration>(migrationPath(orgId), () => true, { state: 'queued', error: null, request_id: randomUUID() });
  await completeEmptyMigration(orgId, await getStore().getDoc<Migration>(migrationPath(orgId)));
}

export async function mediaMigrationStatus(orgId: string) {
  const current = await completeEmptyMigration(orgId, await getStore().getDoc<Migration>(migrationPath(orgId)));
  return current ? { state: current.state, copied_files: current.copied_files, copied_bytes: current.copied_bytes, pending_files: current.pending_files, error: current.error ?? null } : null;
}

async function contentDocumentPaths(orgId: string, siteId: string) {
  const store = getStore();
  const result: string[] = [];
  const versions = new Set(['main', ...(await store.listDocs(paths.versions(orgId, siteId))).map(version => version.id)]);
  for (const version of versions) {
    const root = paths.version(orgId, siteId, version);
    for (const kind of ['settings', 'pages', 'partials', 'block_types', 'page_templates', 'working_copies']) {
      for (const doc of await store.listDocs(`${root}/${kind}`)) {
        const path = `${root}/${kind}/${doc.id}`; result.push(path);
        if (kind === 'pages' || kind === 'partials') for (const revision of await store.listDocs(`${path}/revisions`)) result.push(`${path}/revisions/${revision.id}`);
      }
    }
    for (const collection of await store.listDocs(`${root}/collections`)) {
      const base = `${root}/collections/${collection.id}`; result.push(base);
      for (const item of await store.listDocs(`${base}/items`)) {
        const path = `${base}/items/${item.id}`; result.push(path);
        for (const revision of await store.listDocs(`${path}/revisions`)) result.push(`${path}/revisions/${revision.id}`);
      }
    }
  }
  for (const form of await store.listDocs(paths.forms(orgId, siteId))) result.push(`${paths.forms(orgId, siteId)}/${form.id}`);
  return result;
}

/** Optimistic whole-document comparison preserves an edit made while references were being rewritten. */
export async function rewriteMediaReferences(orgId: string, siteId: string, replacements: Map<string, string>) {
  const store = getStore(); let pending = false;
  for (const path of await contentDocumentPaths(orgId, siteId)) {
    const current = await store.getDoc<Record<string, unknown>>(path);
    if (!current) continue;
    const next = replacePublicationReferences(current, replacements);
    const before = JSON.stringify(current);
    if (JSON.stringify(next) === before) continue;
    const updated = await store.compareAndUpdateDoc<Record<string, unknown>>(path, value => JSON.stringify(value) === before, next);
    if (!updated) pending = true;
  }
  return !pending;
}

/** A bounded, resumable batch. Originals stay readable at the source until the target copy is byte-verified. */
export async function runMediaMigrationBatch(orgId: string, maxFiles = 3) {
  const store = getStore(); const path = migrationPath(orgId); const lease = randomUUID();
  await completeEmptyMigration(orgId, await store.getDoc<Migration>(path));
  const acquired = await store.compareAndUpdateDoc<Migration>(path,
    current => ['queued', 'running'].includes(current.state) && current.lease_until < Date.now(),
    { state: 'running', lease_id: lease, lease_until: Date.now() + 120_000 });
  if (!acquired) return;
  let copied = 0, copiedBytes = 0, pending = 0;
  try {
    const connection = await getConnection(orgId, 'cloudflare');
    if (!connectionSummary(connection).media_ready || !connection.cloudflare) throw new Error('Organization media access is unavailable');
    const destination = { provider: 'organization_r2' as const, account_id: connection.cloudflare.account_id, bucket: connection.cloudflare.bucket };
    const target = await storageClient(orgId, destination);
    try {
      for (const site of await store.listDocs(paths.sites(orgId))) {
        const replacements = new Map<string, string>();
        for (const media of await store.listDocs<Media>(paths.media(orgId, site.id))) {
          for (const alias of media.source_aliases ?? []) replacements.set(alias, media.cdn_url);
          if (media.storage?.provider === 'organization_r2' || !media.r2_key) continue;
          if (media.storage?.state === 'uploading' || copied >= maxFiles) { pending++; continue; }
          if (!await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease && current.lease_until > Date.now(), { lease_until: Date.now() + 120_000 })) return;
          const sourceLocation = media.storage ?? { provider: 'legacy_r2' as const, account_id: process.env.R2_ACCOUNT_ID!, bucket: process.env.R2_BUCKET!, key: media.r2_key };
          const source = sourceLocation.provider === 'legacy_r2' ? new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
            credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } }) : await storageClient(orgId, sourceLocation);
          try {
            const original = await source.send(new GetObjectCommand({ Bucket: sourceLocation.bucket, Key: sourceLocation.key }), { abortSignal: AbortSignal.timeout(20_000) });
            if (!original.Body || !original.ContentLength || original.ContentLength > 25 * 1024 * 1024) throw new Error('Invalid original size');
            const bytes = await original.Body.transformToByteArray(); const digest = hash(bytes);
            if (bytes.length !== original.ContentLength || bytes.length > 25 * 1024 * 1024) throw new Error('Original size changed during migration');
            if (media.sha256 && digest !== media.sha256) throw new Error('Original changed during migration');
            const prefix = await siteMediaPrefix(orgId, site.id);
            const key = `private/${prefix}/originals/${digest}/${media.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            await target.send(new PutObjectCommand({ Bucket: destination.bucket, Key: key, Body: bytes, ContentType: media.mime_type,
              CacheControl: 'private, no-store', Metadata: { sha256: digest } }), { abortSignal: AbortSignal.timeout(20_000) });
            const verified = await target.send(new GetObjectCommand({ Bucket: destination.bucket, Key: key }), { abortSignal: AbortSignal.timeout(20_000) });
            if (!verified.Body || hash(await verified.Body.transformToByteArray()) !== digest) throw new Error('Migration copy failed integrity verification');
            const cdnUrl = `${process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, '')}/api/sites/${encodeURIComponent(site.id)}/media/${media.id}/content`;
            const aliases = [...new Set([...(media.source_aliases ?? []), media.cdn_url, ...(media.variants ?? []).map(variant => variant.cdn_url)])];
            const latestConnection = await getConnection(orgId, 'cloudflare');
            if (latestConnection.status !== 'connected' || latestConnection.cloudflare?.account_id !== destination.account_id || latestConnection.cloudflare?.bucket !== destination.bucket) throw new Error('Media destination changed during migration');
            const changed = await store.compareAndUpdateDoc<Media>(`${paths.media(orgId, site.id)}/${media.id}`,
              current => current.r2_key === media.r2_key && JSON.stringify(current.storage) === JSON.stringify(media.storage),
              { storage: { ...destination, key, generation: connection.revision, state: 'ready', grant_expires_at: new Date().toISOString() }, r2_key: key,
                migration_source: { provider: sourceLocation.provider, account_id: sourceLocation.account_id, bucket: sourceLocation.bucket, key: sourceLocation.key },
                cdn_url: cdnUrl, source_aliases: aliases, sha256: digest, size_bytes: bytes.length, variants: [] });
            if (changed) { copied++; copiedBytes += bytes.length; for (const alias of aliases) replacements.set(alias, cdnUrl); }
            else pending++;
          } finally { source.destroy(); }
        }
        if (replacements.size && !await rewriteMediaReferences(orgId, site.id, replacements)) pending++;
      }
    } finally { target.destroy(); }
    const organization = await getOrganizationDomains(orgId);
    if (organization.media_host && connection.cloudflare.public_bucket) {
      const { preparePublicMediaDomains } = await import('./media-domain');
      await preparePublicMediaDomains(orgId, { account_id: connection.cloudflare.account_id, public_bucket: connection.cloudflare.public_bucket,
        media_host: organization.media_host, website_host: '', site_prefix: '', entries: [] });
    }
    const completed = await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease && current.request_id === acquired.request_id,
      { state: pending ? 'queued' : 'complete', pending_files: pending, copied_files: acquired.copied_files + copied, copied_bytes: acquired.copied_bytes + copiedBytes,
        lease_id: null, lease_until: 0, error: null, updated_at: new Date().toISOString() });
    if (!completed) await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease, { state: 'queued', lease_id: null, lease_until: 0 });
  } catch (error) {
    await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease, { state: 'failed', lease_id: null, lease_until: 0,
      copied_files: acquired.copied_files + copied, copied_bytes: acquired.copied_bytes + copiedBytes, pending_files: pending,
      error: error instanceof ConnectionError ? error.message : 'Media migration paused. Check R2 access in Publishing and retry. Existing source files remain available.' });
  }
}

export async function runPendingMediaMigrations() {
  for (const migration of await getStore().listDocs<Migration>('publishing_media_migrations')) {
    if (migration.state === 'queued' || migration.state === 'running') await runMediaMigrationBatch(migration.org_id);
  }
}
