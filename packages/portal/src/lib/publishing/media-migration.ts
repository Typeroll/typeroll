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
import { requiresSvgSanitization, sanitizeSvgObject, SvgRejectedError, SVG_MEDIA_TYPE, type SvgSanitizedMarker } from '../media/svg-media';

const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
// Each Site migrates its own library. The Organization document only holds
// Organization work (the public media domain); before per-Site jobs it was a
// pass over every Site, which is how an old queued request is recognized.
const organizationPath = (orgId: string) => `publishing_media_migrations/${hash(orgId)}`;
const sitePath = (orgId: string, siteId: string) => `publishing_media_migrations/${hash(`${orgId}\0${siteId}`)}`;
type MigratingMedia = Media & { source_url?: string; import_pending?: boolean };
interface Cursor { site: string; media: string; phase: 'copying' | 'references' | 'next_site'; reference?: string }
interface Migration { scope?: 'organization' | 'site'; site_id?: string; fan_out?: boolean; fan_out_cursor?: string | null; pass_file_failed?: boolean; pass_request_id?: string; cursor?: Cursor | null; pass_copied?: number; pass_bytes?: number; pass_pending?: number; retry_at?: number; failures?: number; org_id: string; state: 'queued' | 'running' | 'complete' | 'failed'; copied_files: number; copied_bytes: number; pending_files: number; lease_id: string | null; lease_until: number; error?: string | null; request_id?: string; updated_at?: string }
const NEW_JOB = { state: 'queued', copied_files: 0, copied_bytes: 0, pending_files: 0, lease_id: null, lease_until: 0 } as const;

/** Zero counters also describe an unscanned job. Check the Site's records before declaring it empty. */
async function completeEmptySite(orgId: string, siteId: string, current: Migration | null): Promise<Migration | null> {
  if (!current || current.state === 'complete' || current.lease_until > Date.now()) return current;
  const store = getStore();
  const site = await store.getDoc<Site>(paths.site(orgId, siteId));
  if (site && !retainsManagedMedia(site) && (await store.listDocs<Media>(paths.media(orgId, siteId), { limit: 1 })).length) return current;
  // A late upload queues a new request after finalization. Never overwrite that
  // request or a worker that acquired the lease while this scan was running.
  await store.compareAndUpdateDoc<Migration>(sitePath(orgId, siteId),
    value => value.request_id === current.request_id && value.state === current.state &&
      value.lease_id === current.lease_id && value.lease_until <= Date.now(),
    { state: 'complete', pending_files: 0, lease_id: null, lease_until: 0, error: null, updated_at: new Date().toISOString() });
  return store.getDoc<Migration>(sitePath(orgId, siteId));
}

async function queueSiteMigration(orgId: string, siteId: string) {
  const store = getStore(), path = sitePath(orgId, siteId);
  await store.createDocIfMissing(path, { org_id: orgId, site_id: siteId, scope: 'site', ...NEW_JOB });
  await store.compareAndUpdateDoc<Migration>(path, () => true, { state: 'queued', error: null, failures: 0, retry_at: 0, request_id: randomUUID() });
  const current = await completeEmptySite(orgId, siteId, await store.getDoc<Migration>(path));
  if (current?.state !== 'complete') {
    const { enqueueMediaMigration } = await import('./media-migration-queue');
    await enqueueMediaMigration(orgId, 0, siteId);
  }
}

/**
 * Move one Site's library to organization storage. Only that Site is read,
 * copied or prepared: an action on one Site never queues work for another.
 */
export async function requestMediaMigration(orgId: string, siteId: string) {
  const connection = await getConnection(orgId, 'cloudflare');
  if (!connectionSummary(connection).media_ready) return;
  await adoptCustomerPublishingForMedia(orgId, siteId);
  await queueSiteMigration(orgId, siteId);
}

/**
 * Organization storage or domains changed. The Organization job gives every
 * Site its own job in the background, then prepares the public media domain.
 * A Site whose files are already in place finishes without copying and
 * without a preparation build.
 */
export async function requestOrganizationMediaMigration(orgId: string) {
  const connection = await getConnection(orgId, 'cloudflare');
  if (!connectionSummary(connection).media_ready) return;
  const store = getStore(), path = organizationPath(orgId);
  await store.createDocIfMissing(path, { org_id: orgId, scope: 'organization', ...NEW_JOB });
  await store.compareAndUpdateDoc<Migration>(path, () => true,
    { state: 'queued', fan_out: true, fan_out_cursor: null, error: null, failures: 0, retry_at: 0, request_id: randomUUID() });
  const { enqueueMediaMigration } = await import('./media-migration-queue');
  await enqueueMediaMigration(orgId);
}

type Status = { state: Migration['state']; copied_files: number; copied_bytes: number; pending_files: number; phase: 'copying' | 'updating_references'; error: string | null };

/** The Organization's media status, summed over its Site jobs. */
export async function mediaMigrationStatus(orgId: string): Promise<Status | null> {
  const listed = await getStore().listDocs<Migration>('publishing_media_migrations', { filters: [{ field: 'org_id', op: '==', value: orgId }] });
  const jobs = await Promise.all(listed.map(async job => job.site_id && job.state !== 'complete' ? await completeEmptySite(orgId, job.site_id, job) ?? job : job));
  if (!jobs.length) return null;
  const has = (state: Migration['state']) => jobs.some(job => job.state === state);
  const failed = jobs.find(job => job.state === 'failed' && job.error) ?? jobs.find(job => job.error);
  return {
    state: has('running') ? 'running' : has('queued') ? 'queued' : has('failed') ? 'failed' : 'complete',
    copied_files: jobs.reduce((sum, job) => sum + (job.copied_files ?? 0), 0),
    copied_bytes: jobs.reduce((sum, job) => sum + (job.copied_bytes ?? 0), 0),
    pending_files: jobs.reduce((sum, job) => sum + (job.pending_files ?? 0), 0),
    phase: jobs.some(job => job.state === 'running' && job.cursor?.phase === 'references') ? 'updating_references' : 'copying',
    error: failed?.error ?? null,
  };
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

/** A cursor and a lease bound every task; a retry reads only the unfinished part of the Site's library. */
export async function runMediaMigrationBatch(orgId: string, siteId: string, maxFiles = 100, budgetMs = 45_000) {
  const store = getStore(); const path = sitePath(orgId, siteId); const lease = randomUUID();
  await completeEmptySite(orgId, siteId, await store.getDoc<Migration>(path));
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
      const site = await store.getDoc<Site>(paths.site(orgId, siteId));
      const sites = site ? [{ ...site, id: siteId }] : [];
      for (const site of sites) {
        if (retainsManagedMedia(site) || cursor?.phase === 'next_site') continue;
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
                    let receipt = await copyWithTransferService({ orgId, sourceUrl, client: target, bucket: destination.bucket, key: temporaryKey,
                      contentType: media.mime_type ?? 'image/jpeg', expectedSha256: media.sha256, expectedSize: media.size_bytes });
                    // Organization storage holds SVG only in sanitized form. The
                    // sanitizer rewrites the staging object and pins the read to
                    // the verified copy; a file it cannot make inert is copied
                    // unchanged, stays private and is refused at publish time.
                    let svg: { mime_type: string; svg_sanitized: SvgSanitizedMarker } | null = null;
                    if (requiresSvgSanitization(media)) {
                      try {
                        const sanitized = await sanitizeSvgObject(target, { bucket: destination.bucket, key: temporaryKey, etag: receipt.etag,
                          expectedSha256: receipt.sha256, expectedSize: receipt.size, cacheControl: 'private, no-store' });
                        receipt = { ...receipt, sha256: sanitized.sha256, size: sanitized.size, etag: sanitized.etag };
                        svg = { mime_type: SVG_MEDIA_TYPE, svg_sanitized: { source_sha256: sanitized.source_sha256, sha256: sanitized.sha256, removed: sanitized.removed } };
                      } catch (error) {
                        if (!(error instanceof SvgRejectedError)) throw error;
                        console.warn(`[media-migration] SVG ${media.id} could not be sanitized; it stays private until it is uploaded again`);
                      }
                    }
                    const digest = receipt.sha256;
                    const key = `private/${prefix}/originals/${digest}/${media.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                    // Freeze exactly the verified staging object without downloading its bytes into the portal.
                    await target.send(new CopyObjectCommand({ Bucket: destination.bucket, Key: key, CopySource: `${destination.bucket}/${temporaryKey}`,
                      CopySourceIfMatch: receipt.etag, ContentType: svg?.mime_type ?? media.mime_type, CacheControl: 'private, no-store', MetadataDirective: 'REPLACE', Metadata: { sha256: digest } }), { abortSignal: AbortSignal.timeout(20_000) });
                    await target.send(new DeleteObjectCommand({ Bucket: destination.bucket, Key: temporaryKey }), { abortSignal: AbortSignal.timeout(20_000) }).catch(() => {});
                    const cdnUrl = `${process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, '')}/api/sites/${encodeURIComponent(site.id)}/media/${media.id}/content`;
                    const aliases = [...new Set([...(media.source_aliases ?? []), media.cdn_url, ...(media.variants ?? []).map(variant => variant.cdn_url)])];
                    const latestConnection = await getConnection(orgId, 'cloudflare');
                    if (latestConnection.status !== 'connected' || latestConnection.cloudflare?.account_id !== destination.account_id || latestConnection.cloudflare?.bucket !== destination.bucket) throw new Error('Media destination changed during migration');
                    const changed = await store.compareAndUpdateDoc<Media>(`${paths.media(orgId, site.id)}/${media.id}`,
                      current => current.r2_key === media.r2_key && JSON.stringify(current.storage) === JSON.stringify(media.storage),
                      { storage: { ...destination, key, generation: connection.revision, state: 'ready', grant_expires_at: new Date().toISOString() }, r2_key: key,
                        migration_source: { provider: sourceLocation.provider, account_id: sourceLocation.account_id, bucket: sourceLocation.bucket, key: sourceLocation.key },
                        cdn_url: cdnUrl, source_aliases: aliases, sha256: digest, size_bytes: receipt.size, variants: [], ...(svg ?? {}) });
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
        // Only newly copied files need preparing; files already in place keep
        // theirs, so a pass with nothing to move queues no build.
        if (copied > 0) {
          const { requestMediaPreparation } = await import('../media/preparation');
          await requestMediaPreparation(orgId, site.id);
        }
        await checkpoint({ site: site.id, media: '', phase: 'next_site' });
      }
    } finally { target.destroy(); }
    if (fileFailure) {
      await store.compareAndUpdateDoc<Migration>(path, value => value.lease_id === lease, { cursor: null, ...counters(), pending_files: pending });
      throw fileFailure;
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

/** Organization work: the public media domain. A request queued before per-Site jobs is handed to each Site. */
async function runOrganizationMediaStep(orgId: string, budgetMs = 45_000) {
  const store = getStore(), path = organizationPath(orgId), lease = randomUUID();
  const acquired = await store.compareAndUpdateDoc<Migration>(path,
    current => ['queued', 'running'].includes(current.state) && current.lease_until < Date.now() && (current.retry_at ?? 0) <= Date.now(),
    { state: 'running', lease_id: lease, lease_until: Date.now() + 120_000 });
  if (!acquired) return;
  const deadline = Date.now() + budgetMs;
  try {
    // A document without scope was queued as one pass over every Site.
    if (acquired.fan_out || acquired.scope !== 'organization') {
      const sites = (await store.listDocs<Site>(paths.sites(orgId))).map(site => site.id).sort();
      for (const siteId of sites) {
        if (acquired.fan_out_cursor && siteId <= acquired.fan_out_cursor) continue;
        if (Date.now() >= deadline) {
          await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease, { state: 'queued', lease_id: null, lease_until: 0, retry_at: 0 });
          return;
        }
        // One Site's settings conflict must not hold back the others; its own
        // job still runs and skips media the Site keeps on managed hosting.
        await adoptCustomerPublishingForMedia(orgId, siteId).catch(error => {
          if (!(error instanceof ConnectionError)) throw error;
          console.warn(`[media-migration] site ${siteId} kept its publishing settings: ${error.code ?? error.status}`);
        });
        await queueSiteMigration(orgId, siteId);
        if (!await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease,
          { fan_out_cursor: siteId, lease_until: Date.now() + 120_000 })) return;
        acquired.fan_out_cursor = siteId;
      }
    }
    const connection = await getConnection(orgId, 'cloudflare');
    if (!connectionSummary(connection).media_ready || !connection.cloudflare) throw new ConnectionError('Media access is unavailable. Check R2 access in Publishing.', 409, 'media_not_ready');
    const organization = await getOrganizationDomains(orgId);
    if (organization.media_host && connection.cloudflare.public_bucket) {
      const { preparePublicMediaDomains } = await import('./media-domain');
      await preparePublicMediaDomains(orgId, { account_id: connection.cloudflare.account_id, public_bucket: connection.cloudflare.public_bucket,
        media_host: organization.media_host, website_host: '', site_prefix: '', entries: [] });
    }
    const completed = await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease && current.request_id === acquired.request_id,
      { scope: 'organization', fan_out: false, fan_out_cursor: null, state: 'complete', cursor: null, pending_files: 0, lease_id: null, lease_until: 0, error: null, failures: 0, retry_at: 0, updated_at: new Date().toISOString() });
    // A new request arrived while this ran: run once more for it, from the first Site.
    if (!completed) await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease,
      { scope: 'organization', fan_out: true, fan_out_cursor: null, state: 'queued', cursor: null, lease_id: null, lease_until: 0, retry_at: 0 });
  } catch (error) {
    const failures = (acquired.failures ?? 0) + 1;
    const terminal = (error instanceof ConnectionError && error.status < 500) || failures >= 3;
    await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease && current.request_id === acquired.request_id,
      { state: terminal ? 'failed' : 'queued', lease_id: null, lease_until: 0, failures, retry_at: terminal ? 0 : Date.now() + failures * 5_000,
        error: error instanceof ConnectionError ? error.message
          : terminal ? 'Media domain setup paused after three attempts. Check R2 access in Publishing and retry.'
          : 'Media domain setup was interrupted. Retrying automatically.' });
    await store.compareAndUpdateDoc<Migration>(path, current => current.lease_id === lease,
      { state: 'queued', lease_id: null, lease_until: 0, retry_at: 0 });
  }
}

const activeDelay = (current: Migration | null) => !current || !['queued', 'running'].includes(current.state) ? null
  : Math.max(0, (current.retry_at ?? 0) - Date.now(), current.lease_until - Date.now());

/**
 * Called only by trusted workers. With a Site, runs that Site's migration;
 * without, the Organization step and pending media preparation. Returns a
 * delay for continued work, or null when finished.
 */
export async function executeMediaMigration(orgId: string, siteId?: string): Promise<number | null> {
  if (siteId) {
    await runMediaMigrationBatch(orgId, siteId);
    return activeDelay(await getStore().getDoc<Migration>(sitePath(orgId, siteId)));
  }
  await runOrganizationMediaStep(orgId);
  const { runPendingMediaPreparation } = await import('../media/preparation');
  const preparing = await runPendingMediaPreparation(orgId);
  return activeDelay(await getStore().getDoc<Migration>(organizationPath(orgId))) ?? (preparing ? 10000 : null);
}

/** Cron is recovery only on Cloud Tasks; portable workers call this on each poll. */
export async function runPendingMediaMigrations() {
  const { runPendingMediaPreparation } = await import('../media/preparation');
  await runPendingMediaPreparation();
  for (const migration of await getStore().listDocs<Migration>('publishing_media_migrations', {
    filters: [{ field: 'state', op: 'in', value: ['queued', 'running'] }],
  })) {
    if (migration.lease_until > Date.now() || (migration.retry_at ?? 0) > Date.now()) continue;
    const siteId = migration.scope === 'site' ? migration.site_id : undefined;
    if ((process.env.DEPLOY_QUEUE ?? 'in_process') === 'cloud_tasks') {
      const { enqueueMediaMigration } = await import('./media-migration-queue');
      await enqueueMediaMigration(migration.org_id, 0, siteId);
    } else if (siteId) await runMediaMigrationBatch(migration.org_id, siteId);
    else await runOrganizationMediaStep(migration.org_id);
  }
}
