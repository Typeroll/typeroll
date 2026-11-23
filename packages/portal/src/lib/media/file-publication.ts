import { createHash, randomUUID } from 'node:crypto';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError, getConnection } from '../publishing/connections';
import { getOrganizationDomains, markOrganizationMediaHostUsed, publicationHostname } from '../publishing/domain-config';
import { storageClient } from '../publishing/media-storage';
import { CopyObjectCommand } from '../net/s3';
import { siteMediaPrefix } from '../media-keys';
import { safeFetch } from '../net/safe-fetch';
import { allocatePublicMediaPaths } from './public-path';

/** Serialize explicit file publication and removal, including separate Worker instances. */
export async function withMediaFileOperation<T>(orgId: string, siteId: string, mediaId: string, operation: () => Promise<T>): Promise<T> {
  const store = getStore(), path = `${paths.media(orgId, siteId)}/${mediaId}`, lease = randomUUID();
  const acquired = await store.compareAndUpdateDoc<Media>(path, value => !value.file_operation || value.file_operation.until < Date.now(),
    { file_operation: { lease, until: Date.now() + 120_000 } });
  if (!acquired) {
    if (!await store.getDoc(path)) throw new ConnectionError('Media not found.', 404, 'media_not_found');
    throw new ConnectionError('This file is being published or removed. Wait for that operation to finish, then retry.', 409, 'media_file_busy');
  }
  const heartbeat = setInterval(() => { void store.compareAndUpdateDoc<Media>(path, value => value.file_operation?.lease === lease,
    { file_operation: { lease, until: Date.now() + 120_000 } }).catch(() => {}); }, 30_000);
  try { return await operation(); }
  finally {
    clearInterval(heartbeat);
    await store.compareAndUpdateDoc<Media>(path, value => value.file_operation?.lease === lease, { file_operation: null });
  }
}

/** Publish a finalized PDF independently of website releases and image preparation. */
export async function publishMediaFile(orgId: string, siteId: string, mediaId: string) {
  return withMediaFileOperation(orgId, siteId, mediaId, async () => {
    const store = getStore(), path = `${paths.media(orgId, siteId)}/${mediaId}`;
    let media = (await store.getDoc<Media>(path))!;
    if (media.mime_type !== 'application/pdf') throw new ConnectionError('Individual file publication currently supports PDFs. Images and videos are published with the website.', 415, 'media_file_type_unsupported');
    if (media.storage?.provider !== 'organization_r2' || media.storage.state !== 'ready' || !/^[a-f0-9]{64}$/.test(media.sha256 ?? '') || !media.size_bytes || media.size_bytes > 25 * 1024 * 1024) {
      throw new ConnectionError('Finish uploading this PDF to the organization’s storage before publishing it.', 409, 'media_file_not_ready');
    }
    if (media.replacement_media_id) throw new ConnectionError('Publish the replacement file instead.', 409, 'media_replaced');
    const storage = media.storage;
    const [domains, connection, prefix] = await Promise.all([getOrganizationDomains(orgId), getConnection(orgId, 'cloudflare'), siteMediaPrefix(orgId, siteId)]);
    if (!domains.media_host) throw new ConnectionError('Connect an organization media domain in Publishing → Domains before publishing a PDF.', 409, 'media_domain_required');
    const host = publicationHostname(domains.media_host), cf = connection.cloudflare;
    if (!connection.media_ready || !cf?.public_bucket || cf.public_bucket === cf.bucket || cf.account_id !== media.storage.account_id || cf.bucket !== media.storage.bucket) {
      throw new ConnectionError('Complete the organization’s private and public media storage setup in Publishing.', 409, 'media_storage_unavailable');
    }
    // Keep the first address across display-name edits and website publications.
    const previous = media.file_publication;
    const chosenPathChanged = media.public_path_allocation ? media.public_path !== media.public_path_allocation.path
      : media.public_path != null && previous?.key !== `${prefix}${media.public_path}`;
    const reusable = !chosenPathChanged && previous && previous.sha256 === media.sha256 && previous.key.startsWith(`${prefix}/`) && previous.url === new URL(`https://${host}/${previous.key}`).href;
    if (!reusable) {
      media = (await allocatePublicMediaPaths(orgId, siteId, [media], await store.listDocs<Media>(paths.media(orgId, siteId)))).get(mediaId)!;
    }
    const key = reusable
      ? previous.key : `${prefix}${media.public_path}`;
    const url = new URL(`https://${host}/${key}`).href;
    await markOrganizationMediaHostUsed(orgId, domains);
    // Record the explicit publication intent BEFORE copying: removal can always find it,
    // including after a process interruption. A pending copy is never labelled verified.
    const publication: NonNullable<Media['file_publication']> = { state: 'pending', url, key, sha256: media.sha256!, verified_at: null };
    const intent = await store.compareAndUpdateDoc<Media>(path,
      current => current.file_operation?.lease === media.file_operation?.lease && current.sha256 === media.sha256 && current.storage?.key === media.storage!.key && JSON.stringify(current.source_aliases) === JSON.stringify(media.source_aliases),
      { file_publication: publication, source_aliases: [...new Set([...(media.source_aliases ?? []), url])] });
    if (!intent) throw new ConnectionError('Media changed while preparing its public link. Retry Publish PDF.', 409, 'media_revision_conflict');
    const r2 = await storageClient(orgId, storage);
    try {
      await r2.send(new CopyObjectCommand({ Bucket: cf.public_bucket, Key: key,
        CopySource: `${storage.bucket}/${storage.key}`, MetadataDirective: 'REPLACE',
        ContentType: 'application/pdf', ContentDisposition: 'inline', CacheControl: 'public, max-age=31536000, immutable',
        Metadata: { sha256: media.sha256! } }), { abortSignal: AbortSignal.timeout(30_000) });
    } catch {
      throw new ConnectionError('The PDF could not be copied to public storage. Retry Publish PDF; the upload is preserved.', 502, 'media_file_copy_failed');
    } finally { r2.destroy(); }
    // Real anonymous delivery, bounded and SSRF guarded. Never accept a login page,
    // redirect, wrong MIME type or a host that serves different bytes.
    try {
      const response = await safeFetch(url, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' } },
        { label: 'Published PDF', timeoutMs: 15_000, maxBytes: 25 * 1024 * 1024 });
      if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/pdf') {
        await response.body?.cancel(); throw new Error('Unexpected public response');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== media.size_bytes || createHash('sha256').update(bytes).digest('hex') !== media.sha256 ||
          !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('Unexpected public bytes');
    } catch {
      throw new ConnectionError('The PDF was copied, but its public address could not be verified. Check the media domain in Publishing, then retry Publish PDF. No website build is needed.', 409, 'media_file_verification_pending');
    }
    publication.state = 'public'; publication.verified_at = new Date().toISOString();
    const saved = await store.compareAndUpdateDoc<Media>(path, current => current.sha256 === media.sha256 && current.storage?.key === media.storage!.key && current.file_operation?.lease === media.file_operation?.lease,
      { file_publication: publication });
    if (!saved) throw new ConnectionError('The file changed during publication. Refresh its details and retry.', 409, 'media_revision_conflict');
    return { media_id: mediaId, state: 'public' as const, public_url: url, verified_at: publication.verified_at, website_build_required: false };
  });
}
