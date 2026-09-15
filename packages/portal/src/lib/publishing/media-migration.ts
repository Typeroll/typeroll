import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { copyWithTransferService } from '../media/remote-transfer';
import { createHash, randomUUID } from 'node:crypto';
import { S3Client, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { paths, type Media, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { connectionSummary, getConnection, ConnectionError } from './connections';
import { getOrganizationDomains } from './domain-config';
import { adoptCustomerPublishingForMedia, retainsManagedMedia } from './media-policy';
import { storageClient } from './media-storage';
import { mediaTransfers, transferReservation, transferPath } from '../media/transfer';
import { replacePublicationReferences } from './media-manifest';

const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const migrationPath = (orgId: string) => `publishing_media_migrations/${hash(orgId)}`;
type MigratingMedia = Media & { source_url?: string; import_pending?: boolean };
interface Cursor { site: string; media: string; phase: 'copying' | 'references' | 'next_site'; reference?: string }
interface Migration { pass_file_failed?: boolean; pass_request_id?: string; cursor?: Cursor | null; pass_copied?: number; pass_bytes?: number; pass_pending?: number; retry_at?: number; failures?: number; org_id: string; state: 'queued' | 'running' | 'complete' | 'failed'; copied_files: number; copied_bytes: number; pending_files: number; lease_id: string | null; lease_until: number; error?: string | null; request_id?: string }

/** Zero counters also describe an unscanned job. Check the records before declaring it empty. */
async function completeEmptyMigration(orgId: string, current: Migration | null): Promise<Migration | null> {
  if (!current || current.state === 'complete' || current.lease_until > Date.now()) return current;
  const store = getStore();
  for (const site of await store.listDocs<Site>(paths.sites(orgId))) {
    if (retainsManagedMedia(site)) continue;
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
  const connection = await getConnection(orgId, 'cloudflare');
  if (!connectionSummary(connection).media_ready) return;
  for (const site of await getStore().listDocs(paths.sites(orgId))) await adoptCustomerPublishingForMedia(orgId, site.id);
  await getStore().createDocIfMissing(migrationPath(orgId), { org_id: orgId, state: 'queued', copied_files: 0, copied_bytes: 0, pending_files: 0, lease_id: null, lease_until: 0 });
  await getStore().compareAndUpdateDoc<Migration>(migrationPath(orgId), () => true, { state: 'queued', error: null, failures: 0, retry_at: 0, request_id: randomUUID() });
  const current = await completeEmptyMigration(orgId, await getStore().getDoc<Migration>(migrationPath(orgId)));
  if (current?.state !== 'complete') {
    const { enqueueMediaMigration } = await import('./media-migration-queue');
    await enqueueMediaMigration(orgId);
  }
}

export async function mediaMigrationStatus(orgId: string) {
  const current = await completeEmptyMigration(orgId, await getStore().getDoc<Migration>(migrationPath(orgId)));
  return current ? { state: current.state, copied_files: current.copied_files, copied_bytes: current.copied_bytes, pending_files: current.pending_files, phase: current.cursor?.phase === 'references' ? 'updating_references' : 'copying', error: current.error ?? null } : null;
}

async function contentDocumentPaths(orgId: string, siteId: string) {
  const store = getStore();
  const result: string[] = [];
  const versions = new Set(['main', ...(await store.listDocs(paths.versions(orgId, siteId))).map(version => version.id)]);
  for (const version of versions) {
    const root = paths.version(orgId, siteId, version);
    for (const kind of ['settings', 'pages', 'partials', 'block_types', 'page_templates', 'working_copies', 'content_types']) {
      for (const doc of await store.listDocs(`${root}/${kind}`)) {
        const path = `${root}/${kind}/${doc.id}`; result.push(path);
        if (kind === 'pages' || kind === 'partials') for (const revision of await store.listDocs(`${path}/revisions`)) result.push(`${path}/revisions/${revision.id}`);
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

class MediaIntegrityError extends Error {}
class MigrationLeaseLost extends Error {}

/** A cursor and a lease bound every task; a retry reads only the unfinished part of the library. */
export async function runMediaMigrationBatch(orgId: string, maxFiles = 100, budgetMs = 45_000) {
  const store = getStore(); const path = migrationPath(orgId); const lease = randomUUID();
  await completeEmptyMigration(orgId, await store.getDoc<Migration>(path));
  const acquired = await store.compareAndUpdateDoc<Migration>(path,
    current => ['queued', 'running'].includes(current.state) && current.lease_until < Date.now() && (current.retry_at ?? 0) <= Date.now(),
    { state: 'running', lease_id: lease, lease_until: Date.now() + 120_000 });
  if (!acquired) return;
  const heartbeat = setInterval(() => { void store.compareAndUpdateDoc<Migration>(path, value => value.lease_id === lease && value.lease_until > Date.now(), { lease_until: Date.now() + 120000 }).catch(() => {}); }, 20000);
  heartbeat.unref();
  const deadline = Date.now() + budgetMs;
  let cursor = acquired.cursor ?? null;
  const passRequest = cursor ? acquired.pass_request_id ?? acquired.request_id : acquired.request_id;
  let copied = cursor ? acquired.pass_copied ?? 0 : 0;
  let copiedBytes = cursor ? acquired.pass_bytes ?? 0 : 0;
  let pending = cursor ? acquired.pass_pending ?? 0 : 0;
  let processed = 0;
  let fileFailure: unknown = acquired.cursor && acquired.pass_file_failed ? new Error('media_transfer_interrupted') : undefined;
  const counters = () => ({ pass_copied: copied, pass_bytes: copiedBytes, pass_pending: pending, pass_file_failed: Boolean(fileFailure),
    copied_files: Math.max(acquired.copied_files, copied), copied_bytes: Math.max(acquired.copied_bytes, copiedBytes) });
  const checkpoint = async (next: Cursor) => {
    if (!await store.compareAndUpdateDoc<Migration>(path, value => value.lease_id === lease && value.lease_until > Date.now(),
      { ...counters(), pass_request_id: passRequest, cursor: next, lease_until: Date.now() + 120_000, updated_at: new Date().toISOString() })) throw new MigrationLeaseLost();
    cursor = next;
  };
  const yieldBatch = async () => {
    await store.compareAndUpdateDoc<Migration>(path, value => value.lease_id === lease,
      { state: 'queued', lease_id: null, lease_until: 0, ...counters(), error: fileFailure ? 'Some files need another transfer attempt.' : null, retry_at: 0 });
  };
  try {
    const connection = await getConnection(orgId, 'cloudflare');
    if (!connectionSummary(connection).media_ready || !connection.cloudflare) throw new ConnectionError('Media access is unavailable. Check R2 access in Publishing.', 409, 'media_not_ready');
    const destination = { provider: 'organization_r2' as const, account_id: connection.cloudflare.account_id, bucket: connection.cloudflare.bucket };
    const target = await storageClient(orgId, destination);
    try {
      const sites = (await store.listDocs<Site>(paths.sites(orgId))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const site of sites) {
        if (retainsManagedMedia(site) || (cursor && (site.id < cursor.site || (site.id === cursor.site && cursor.phase === 'next_site')))) continue;
        if (!cursor || cursor.site !== site.id) await checkpoint({ site: site.id, media: '', phase: 'copying' });
        if (cursor!.phase === 'copying') {
          for (;;) {
            if (processed >= Math.max(1, maxFiles) || Date.now() >= deadline) { await yieldBatch(); return; }
            const page = await store.listDocs<MigratingMedia>(paths.media(orgId, site.id), { startAfterId: cursor!.media, limit: Math.max(1, Math.min(100, maxFiles - processed)) });
            if (!page.length) break;
            for (let offset = 0; offset < page.length; offset += 4) {
              if (Date.now() >= deadline) { await yieldBatch(); return; }
              await checkpoint(cursor!);
              const group = page.slice(offset, offset + 4);
              const results = await Promise.allSettled(group.map(originalMedia => { const transfer = async () => {
                let media = originalMedia;
                const recordPath = transferPath(paths.site(orgId, site.id), `storage:${destination.account_id}:${destination.bucket}:${media.id}`);
                await store.createDocIfMissing(recordPath, { state: 'queued', attempts: 0, lease_until: 0 });
                const record = await store.getDoc<{ attempts: number }>(recordPath);
                await store.updateDoc(recordPath, { state: 'running', attempts: (record?.attempts ?? 0) + 1, lease_until: Date.now() + 120_000 });
                try {
              if (media.import_pending && media.source_url) {
                const importLease = await store.getDoc<{ lease_until: number }>(transferPath(paths.site(orgId, site.id), media.source_url));
                if ((importLease?.lease_until ?? 0) > Date.now()) { pending++; return media; }
                const { WPMediaTransfer } = await import('../wp/media');
                await new WPMediaTransfer(orgId, site.id, store).ensureUrl(media.source_url, media.alt_text);
                media = (await store.getDoc<MigratingMedia>(`${paths.media(orgId, site.id)}/${media.id}`))!;
                if (media.storage?.state === 'ready') {
                  await store.updateDoc(`${paths.media(orgId, site.id)}/${media.id}`, { import_pending: false, import_error: null });
                  media.import_pending = false;
                }
              }
              if (media.storage?.provider !== 'organization_r2' && media.r2_key) {
                if (media.storage?.state === 'uploading') pending++;
                else {
                  const sourceLocation = media.storage ?? { provider: 'legacy_r2' as const, account_id: process.env.R2_ACCOUNT_ID!, bucket: process.env.R2_BUCKET!, key: media.r2_key };
                  const source = sourceLocation.provider === 'legacy_r2' ? new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
                    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } }) : await storageClient(orgId, sourceLocation);
                  try {
                    const prefix = await siteMediaPrefix(orgId, site.id);
                    const temporaryKey = `transfer-staging/${prefix}/${randomUUID()}`;
                    const sourceUrl = await getSignedUrl(source, new GetObjectCommand({ Bucket: sourceLocation.bucket, Key: sourceLocation.key }), { expiresIn: 600 });
                    const receipt = await copyWithTransferService({ orgId, sourceUrl, client: target, bucket: destination.bucket, key: temporaryKey,
                      contentType: media.mime_type ?? 'image/jpeg', expectedSha256: media.sha256, expectedSize: media.size_bytes });
                    const digest = receipt.sha256;
                    const key = `private/${prefix}/originals/${digest}/${media.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                    // Freeze exactly the verified staging object without downloading its bytes into the portal.
                    await target.send(new CopyObjectCommand({ Bucket: destination.bucket, Key: key, CopySource: `${destination.bucket}/${temporaryKey}`,
                      CopySourceIfMatch: receipt.etag, ContentType: media.mime_type, CacheControl: 'private, no-store', MetadataDirective: 'REPLACE', Metadata: { sha256: digest } }), { abortSignal: AbortSignal.timeout(20_000) });
                    await target.send(new DeleteObjectCommand({ Bucket: destination.bucket, Key: temporaryKey }), { abortSignal: AbortSignal.timeout(20_000) }).catch(() => {});
                    const cdnUrl = `${process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, '')}/api/sites/${encodeURIComponent(site.id)}/media/${media.id}/content`;
                    const aliases = [...new Set([...(media.source_aliases ?? []), media.cdn_url, ...(media.variants ?? []).map(variant => variant.cdn_url)])];
                    const latestConnection = await getConnection(orgId, 'cloudflare');
                    if (latestConnection.status !== 'connected' || latestConnection.cloudflare?.account_id !== destination.account_id || latestConnection.cloudflare?.bucket !== destination.bucket) throw new Error('Media destination changed during migration');
                    const changed = await store.compareAndUpdateDoc<Media>(`${paths.media(orgId, site.id)}/${media.id}`,
                      current => current.r2_key === media.r2_key && JSON.stringify(current.storage) === JSON.stringify(media.storage),
                      { storage: { ...destination, key, generation: connection.revision, state: 'ready', grant_expires_at: new Date().toISOString() }, r2_key: key,
                        migration_source: { provider: sourceLocation.provider, account_id: sourceLocation.account_id, bucket: sourceLocation.bucket, key: sourceLocation.key },
                        cdn_url: cdnUrl, source_aliases: aliases, sha256: digest, size_bytes: receipt.size, variants: [] });
                    if (!changed) pending++;
                    media = (await store.getDoc<Media>(`${paths.media(orgId, site.id)}/${media.id}`)) ?? media;
                  } finally { source.destroy(); }
                }
              }

                  await store.updateDoc(recordPath, { state: media.storage?.provider === 'organization_r2' ? 'complete' : 'queued', lease_until: 0, error_code: null });
                  return media;
                } catch (error) {
                  await store.updateDoc(recordPath, { state: 'failed', lease_until: 0,
                    error_code: error instanceof MediaIntegrityError ? 'integrity_verification_failed' : 'transfer_interrupted' });
                  throw error;
                }
              }; return originalMedia.import_pending ? transfer() : mediaTransfers.run(destination.account_id, transferReservation, transfer); }));
              for (let index = 0; index < results.length; index++) {
                const result = results[index];
                if (result.status === 'rejected') { pending++; fileFailure ??= result.reason; }
                else if (result.value.storage?.provider === 'organization_r2' && (result.value.migration_source || (result.value.source_url && result.value.import_pending === false))) {
                  copied++; copiedBytes += result.value.size_bytes ?? 0;
                }
                processed++;
              }
              // Failed files are retried on the next pass. Healthy siblings are
              // durable and never need copying again, even after process loss.
              await checkpoint({ site: site.id, media: group.at(-1)!.id, phase: 'copying' });
            }
          }
          await checkpoint({ site: site.id, media: cursor!.media, phase: 'references' });
        }
        // Rewrite once after the site's copies, not once for every small batch.
        // Aliases are durable, so a crash or concurrent edit can safely retry.
        const replacements = new Map<string, string>();
        for (const media of await store.listDocs<Media>(paths.media(orgId, site.id))) {
          if (media.storage?.state === 'ready') for (const alias of media.source_aliases ?? []) replacements.set(alias, media.cdn_url);
        }
        const referencePaths = replacements.size ? (await contentDocumentPaths(orgId, site.id)).sort() : [];
        for (const referencePath of referencePaths) {
          if (cursor!.reference && referencePath <= cursor!.reference) continue;
          if (Date.now() >= deadline) { await yieldBatch(); return; }
          await checkpoint(cursor!);
          const current = await store.getDoc<Record<string, unknown>>(referencePath);
          if (current) {
            const next = replacePublicationReferences(current, replacements);
            const before = JSON.stringify(current);
            if (JSON.stringify(next) !== before && !await store.compareAndUpdateDoc<Record<string, unknown>>(referencePath,
              value => JSON.stringify(value) === before, next)) pending++;
          }
          await checkpoint({ ...cursor!, reference: referencePath });
        }
        const { requestMediaPreparation } = await import('../media/preparation');
        await requestMediaPreparation(orgId, site.id);
        await checkpoint({ site: site.id, media: '', phase: 'next_site' });
      }
    } finally { target.destroy(); }
    if (fileFailure) {
      await store.compareAndUpdateDoc<Migration>(path, value => value.lease_id === lease, { cursor: null, ...counters(), pending_files: pending });
      throw fileFailure;
    }
    const organization = await getOrganizationDomains(orgId);
    if (organization.media_host && connection.cloudflare.public_bucket) {
      const { preparePublicMediaDomains } = await import('./media-domain');
      await preparePublicMediaDomains(orgId, { account_id: connection.cloudflare.account_id, public_bucket: connection.cloudflare.public_bucket,
        media_host: organization.media_host, website_host: '', site_prefix: '', entries: [] });
    }
    const completed = await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease && current.request_id === passRequest,
      { state: pending ? 'queued' : 'complete', pending_files: pending, ...counters(), cursor: null,
        lease_id: null, lease_until: 0, error: null, failures: 0, retry_at: pending ? Date.now() + 5_000 : 0, updated_at: new Date().toISOString() });
    // A late upload or site opt-in may sort before the saved cursor. Finish this
    // pass, then rescan once for the new request without losing copy progress.
    if (!completed) await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease,
      { state: 'queued', cursor: null, ...counters(), lease_id: null, lease_until: 0, retry_at: 0 });
  } catch (error) {
    if (error instanceof MigrationLeaseLost) return;
    const failures = (acquired.failures ?? 0) + 1;
    const terminal = error instanceof MediaIntegrityError || (error instanceof ConnectionError && error.status < 500) || failures >= 3;
    await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease && current.request_id === acquired.request_id,
      { state: terminal ? 'failed' : 'queued', lease_id: null, lease_until: 0, failures,
        retry_at: terminal ? 0 : Date.now() + failures * 5_000, pending_files: pending,
        error: error instanceof MediaIntegrityError ? 'A media copy could not be verified. The original is unchanged. Retry media migration; if it fails again, check the original file.'
          : error instanceof ConnectionError ? error.message
          : terminal ? 'Media migration paused after three attempts. Check R2 access in Publishing and retry. Existing source files remain available.'
          : 'The transfer was interrupted. Retrying automatically; existing source files remain available.' });
    // Do not let an old failure overwrite a newly requested retry.
    await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease,
      { state: 'queued', lease_id: null, lease_until: 0, retry_at: 0 });
  } finally { clearInterval(heartbeat); }
}

/** Called only by trusted workers. Returns a delay for continued work, or null when finished. */
export async function executeMediaMigration(orgId: string): Promise<number | null> {
  await runMediaMigrationBatch(orgId);
  const { runPendingMediaPreparation } = await import('../media/preparation');
  const preparing = await runPendingMediaPreparation(orgId);
  const current = await getStore().getDoc<Migration>(migrationPath(orgId));
  if (!current || !['queued', 'running'].includes(current.state)) return preparing ? 10000 : null;
  return Math.max(0, (current.retry_at ?? 0) - Date.now(), current.lease_until - Date.now());
}

/** Cron is recovery only on Cloud Tasks; portable workers call this on each poll. */
export async function runPendingMediaMigrations() {
  const { runPendingMediaPreparation } = await import('../media/preparation');
  await runPendingMediaPreparation();
  for (const migration of await getStore().listDocs<Migration>('publishing_media_migrations', {
    filters: [{ field: 'state', op: 'in', value: ['queued', 'running'] }],
  })) {
    if (migration.lease_until > Date.now() || (migration.retry_at ?? 0) > Date.now()) continue;
    if ((process.env.DEPLOY_QUEUE ?? 'in_process') === 'cloud_tasks') {
      const { enqueueMediaMigration } = await import('./media-migration-queue');
      await enqueueMediaMigration(migration.org_id);
    } else await runMediaMigrationBatch(migration.org_id);
  }
}
