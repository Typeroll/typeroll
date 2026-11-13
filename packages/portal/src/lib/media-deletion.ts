// Deleting the bytes behind a media record.
//
// This exists because the previous behaviour, inline in the media DELETE
// route, dropped the document and kept the object in two common cases:
//
//   1. It attempted R2 only when `!media.storage`, so every object in an
//      organization's own R2 — which is where media lands once a customer
//      connects their storage, i.e. the normal case — had its document
//      deleted and its bytes left behind, unreferenced and unfindable.
//   2. It never touched variants. Every image carries webp and avif copies at
//      several widths, so a single delete orphaned up to a dozen objects.
//
// Both were silent: the failure path swallowed everything, and an orphan in
// object storage announces itself to nobody. The comment justifying that
// traded a dangling link in the UI against an orphan object, which was the
// right call for one image and the wrong one as a policy — nothing ever came
// back to collect them.
//
// So: enumerate every key a record points at, delete each from the right
// bucket, and REPORT what failed rather than swallowing it. Callers decide
// whether a failure should block; they cannot decide if they are not told.

//
// Published copies are a second set of objects: the build writes them into
// the organization's PUBLIC bucket for every address a publication served the
// file at, and they outlived every delete until lib/media/public-copies.ts.
// Deleting a media item now removes them too and purges Cloudflare's cache.
// A tombstone (`media_removals/{id}`) replaces the record as the index of what
// is left to remove, so the record goes at once — the owner asked for it to go
// — and a failed removal or an unavailable cache purge stays retryable with
// `remove_published_media_copies`.

import { r2Endpoint } from './r2-endpoint';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from './datastore';
import { storageClient } from './publishing/media-storage';
import { ConnectionError } from './publishing/connections';
import {
  copyScope, emptySubject, existingClaims, findMediaReferences, identityBases, identityUrls, keyForUrl, mediaIdentity, mediaRemovalPath,
  privateCopiesSummary, publicCopiesSummary, referenceWarnings, removalIncomplete, removeCopies, scanPublicationMedia, splitCopyKey, validMediaId,
  type Claims, type CopyRemovalResult, type CopyScope, type CopySubject, type MediaIdentity, type MediaRemovalRecord, type UrlRefusal,
} from './media/public-copies';

/** One object to remove, and where it lives. */
export interface MediaObject {
  key: string;
  /**
   * `null` means the platform-managed public bucket, addressed through the
   * R2_* environment. Objects predating the `storage` field live there and
   * carry no location of their own.
   */
  location: NonNullable<Media['storage']> | null;
  /** Which field produced this key — surfaced in results so a failure is diagnosable. */
  source: 'storage' | 'r2_key' | 'migration_source' | 'variant';
}

/**
 * Every object key a media record points at.
 *
 * Built from the record rather than from the site's key prefix, because three
 * generations of key coexist — `r2_key` from before the storage field,
 * `storage.key` for current objects, and `migration_source.key` for where an
 * object sat before the organization moved to its own storage. Only the middle
 * one is under `media/{site.media_id}/`, so a prefix sweep silently leaves the
 * other two behind, on exactly the sites old enough to have them.
 *
 * Variant keys come from their `cdn_url` path. Variants are written beside
 * their base object, so they are removed from the same location as the record
 * that owns them.
 */
export function mediaObjects(media: Media): MediaObject[] {
  const out: MediaObject[] = [];
  const seen = new Set<string>();
  const location = media.storage ?? null;
  const add = (key: string | undefined, source: MediaObject['source'], where: MediaObject['location']) => {
    if (!key || seen.has(`${where?.bucket ?? ''}:${key}`)) return;
    seen.add(`${where?.bucket ?? ''}:${key}`);
    out.push({ key, location: where, source });
  };

  add(media.storage?.key, 'storage', media.storage ?? null);
  add(media.r2_key, 'r2_key', media.storage ? location : null);
  if (media.migration_source?.bucket && media.migration_source.key) {
    add(media.migration_source.key, 'migration_source', {
      provider: media.migration_source.provider === 'draft_r2' ? 'draft_r2' : 'organization_r2',
      account_id: media.migration_source.account_id ?? '',
      bucket: media.migration_source.bucket,
      key: media.migration_source.key,
      generation: '',
      state: 'ready',
      grant_expires_at: '',
    });
  }
  for (const variant of media.variants ?? []) {
    add(variantKey(variant.cdn_url), 'variant', location);
  }
  return out;
}

/**
 * The object key behind a variant's public URL.
 *
 * Variants record a URL, not a key, because that is what the renderer needs.
 * The key is the URL path — the same relationship the publication manifest
 * relies on when it maps a CDN URL back to an object.
 */
export function variantKey(cdnUrl: string | undefined): string | undefined {
  if (!cdnUrl) return undefined;
  try {
    return new URL(cdnUrl).pathname.replace(/^\/+/, '') || undefined;
  } catch {
    return undefined;
  }
}

export interface MediaDeletionResult {
  deleted: number;
  /** Objects that could not be removed. Their records are kept, so they stay findable. */
  failed: Array<{ key: string; source: MediaObject['source']; reason: string }>;
  /** Objects another existing record still points at (the same bytes stored once); left in place. */
  kept: Array<{ key: string; source: MediaObject['source']; referenced_by: string }>;
}

/** Delete one object, resolving the client for wherever it lives. */
async function deleteObject(orgId: string, object: MediaObject): Promise<void> {
  const { DeleteObjectCommand } = await import('./net/s3');
  if (object.location) {
    const client = await storageClient(orgId, object.location);
    await client.send(new DeleteObjectCommand({ Bucket: object.location.bucket, Key: object.key }));
    return;
  }
  const { S3Client } = await import('./net/s3');
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error('Managed media storage is not configured');
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: r2Endpoint(accountId, bucket),
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
}

/**
 * Remove the objects behind one media record.
 *
 * A key that is already gone counts as deleted: these calls have to be
 * re-runnable, and R2 answers a missing key with success anyway.
 */
export async function deleteMediaObjects(orgId: string, media: Media, options: { claims?: Pick<Claims, 'private_keys'> } = {}): Promise<MediaDeletionResult> {
  const result: MediaDeletionResult = { deleted: 0, failed: [], kept: [] };
  for (const object of mediaObjects(media)) {
    // Originals are content-addressed (`originals/<sha256>/<name>`): the same
    // file imported twice shares one object, which must outlive this record.
    const referencedBy = options.claims?.private_keys.get(object.key);
    if (referencedBy && referencedBy !== media.id) {
      result.kept.push({ key: object.key, source: object.source, referenced_by: referencedBy });
      continue;
    }
    try {
      await deleteObject(orgId, object);
      result.deleted += 1;
    } catch (error) {
      result.failed.push({
        key: object.key,
        source: object.source,
        reason: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  return result;
}

/** The copies to look for of one media identity: its published bases and its prepared variants. */
function identitySubject(identity: MediaIdentity, scope: CopyScope): CopySubject {
  const subject = emptySubject(identity.id);
  for (const base of identityBases(identity, scope)) subject.bases.add(base);
  if (identity.sha256 && /^[a-f0-9]{64}$/.test(identity.sha256) && identity.storage?.provider === 'organization_r2') subject.prepared_shas.add(identity.sha256);
  return subject;
}

const forMedia = (result: CopyRemovalResult, mediaId: string) => ({
  failed: result.objects.some(object => object.media_id === mediaId && object.status === 'failed') || result.errors.some(error => error.media_id === mediaId),
  urls: [...new Set(result.objects.filter(object => object.media_id === mediaId && object.status === 'removed').flatMap(object => object.urls ?? []))],
});

/** Counts only: the tombstone stays small and never repeats keys a listing can find again. */
function resultCounts(result: CopyRemovalResult, privateObjects?: MediaDeletionResult) {
  const count = (bucket: 'public' | 'private', status: string) => result.objects.filter(object => object.bucket === bucket && object.status === status).length;
  return { public_removed: count('public', 'removed'), public_failed: count('public', 'failed') + result.errors.length, public_protected: count('public', 'protected'),
    prepared_removed: count('private', 'removed'), prepared_failed: count('private', 'failed'), purge_pending: result.cache.pending_urls.length,
    ...(privateObjects ? { private_deleted: privateObjects.deleted, private_failed: privateObjects.failed.length, private_kept: privateObjects.kept.length } : {}) };
}

async function updateTombstone(orgId: string, siteId: string, tombstone: MediaRemovalRecord, result: CopyRemovalResult, privateObjects?: MediaDeletionResult): Promise<MediaRemovalRecord> {
  const own = forMedia(result, tombstone.media_id);
  const pending = new Set(result.cache.pending_urls);
  // URLs left unpurged earlier stay pending until a purge of them succeeds.
  const unpurged = [...new Set([...tombstone.unpurged_urls, ...own.urls])].filter(url => pending.has(url));
  const complete = !own.failed && !unpurged.length && !(privateObjects?.failed.length);
  const next: MediaRemovalRecord = { ...tombstone, state: complete ? 'complete' : 'pending', updated_at: new Date().toISOString(),
    attempts: tombstone.attempts + 1, unpurged_urls: unpurged, last_result: resultCounts(result, privateObjects) };
  await getStore().setDoc(mediaRemovalPath(orgId, siteId, tombstone.media_id), next);
  return next;
}

/** The removal already happened; a failed reference check must not turn it into an error. */
async function referencesOrNote(orgId: string, siteId: string, input: { urls: string[]; mediaIds: string[] }) {
  try { return await findMediaReferences(orgId, siteId, input); }
  catch (error) {
    console.error(`[media-deletion] reference check failed site=${siteId}: ${error instanceof Error ? error.message : 'unknown'}`);
    return { redirects: [], content: [], content_total: 0, unavailable: 'The check for redirects and content that still reference this media failed; review them with list_redirects and search.' };
  }
}

export interface MediaItemDeletion {
  status: 200 | 207;
  body: Record<string, unknown>;
}

/**
 * Delete one media item and everything it left behind: its private objects,
 * its prepared variants, every published copy in the public bucket, and the
 * Cloudflare cache for each URL those copies were served at.
 *
 * The record is replaced by a tombstone first and deleted before the cleanup
 * runs, so it is gone whatever storage says. What could not be removed — an
 * object, or a cache purge the connection is not allowed to make — keeps the
 * tombstone `pending`, is reported here (HTTP 207), and is retried by
 * `remove_published_media_copies` with the same media id. Objects another
 * existing record still points at stay.
 */
export async function deleteMediaItem(orgId: string, siteId: string, mediaId: string, options: { actor?: string | null } = {}): Promise<MediaItemDeletion | null> {
  const store = getStore();
  const docPath = `${paths.media(orgId, siteId)}/${mediaId}`;
  const media = await store.getDoc<Media>(docPath);
  if (!media) return null;
  const record: Media = { ...media, id: mediaId };
  const [scope, records] = await Promise.all([copyScope(orgId, siteId), store.listDocs<Media>(paths.media(orgId, siteId))]);
  const claims = existingClaims(records, scope, new Set([mediaId]));
  const now = new Date().toISOString();
  const tombstone: MediaRemovalRecord = { media_id: mediaId, state: 'pending', identity: mediaIdentity(record), created_at: now, updated_at: now,
    attempts: 0, unpurged_urls: [], deleted_by: options.actor ?? null };
  await store.setDoc(mediaRemovalPath(orgId, siteId, mediaId), tombstone);
  await store.deleteDoc(docPath);

  const privateObjects = await deleteMediaObjects(orgId, record, { claims });
  const copies = await removeCopies(orgId, siteId, { scope, subjects: [identitySubject(tombstone.identity, scope)], claims, dryRun: false });
  const saved = await updateTombstone(orgId, siteId, tombstone, copies, privateObjects);
  const references = await referencesOrNote(orgId, siteId, { urls: [...identityUrls(tombstone.identity), ...copies.urls], mediaIds: [mediaId] });
  const publicCopies = publicCopiesSummary(copies);
  const warnings = [...referenceWarnings(references, publicCopies.removed.length), ...('unavailable' in references ? [references.unavailable] : []), ...copies.cache.unavailable.map(entry => entry.message)];
  if (saved.state === 'pending') warnings.push(`Some copies of this media were not removed${saved.unpurged_urls.length ? ' or their cache was not purged' : ''}. The record is deleted; run remove_published_media_copies with media_ids ["${mediaId}"] to retry exactly what is left.`);
  return {
    status: saved.state === 'complete' ? 200 : 207,
    body: {
      ok: true, media_id: mediaId, objects_deleted: privateObjects.deleted,
      private_objects: { deleted: privateObjects.deleted, failed: privateObjects.failed, kept: privateObjects.kept },
      private_copies: privateCopiesSummary(copies),
      public_copies: publicCopies,
      removal: { state: saved.state, unpurged_urls: saved.unpurged_urls },
      references, warnings,
    },
  };
}

export interface SiteMediaPurgeResult {
  records: number;
  objects_deleted: number;
  records_removed: number;
  /** Records deliberately kept because their objects could not be removed. */
  records_retained: number;
  failed: Array<{ media_id: string; key: string; source: MediaObject['source'] | 'public_copy'; reason: string }>;
  /** Published copies in the public bucket and the cache purge of their URLs. */
  public_copies: ReturnType<typeof publicCopiesSummary>;
}

/**
 * Remove every media object a site owns, then the records that pointed at them.
 *
 * Objects first, record second, and the record is kept when any of its objects
 * survive. That is the opposite of the single-item route's old trade-off, and
 * deliberately so: there, a user wanted the name freed and an orphan was an
 * acceptable price. Here the record is the only remaining index of those
 * bytes, so dropping it while the bytes survive converts a retryable failure
 * into storage nobody can find, bill correctly, or clean up.
 *
 * Published copies count as the record's objects: a record whose copies could
 * not be removed is kept too. Every record goes, so no record protects another.
 *
 * Re-runnable by construction — a second call retries exactly the records
 * whose objects did not go.
 */
export async function purgeSiteMedia(orgId: string, siteId: string): Promise<SiteMediaPurgeResult> {
  const store = getStore();
  const records = await store.listDocs<Media>(paths.media(orgId, siteId));
  const scope = await copyScope(orgId, siteId);
  const noClaims = existingClaims([], scope, new Set());
  const failedPrivate = new Map<string, MediaDeletionResult['failed']>();
  let objectsDeleted = 0;
  for (const media of records) {
    const outcome = await deleteMediaObjects(orgId, media);
    objectsDeleted += outcome.deleted;
    if (outcome.failed.length > 0) failedPrivate.set(media.id, outcome.failed);
  }
  const copies = await removeCopies(orgId, siteId, { scope, subjects: records.map(media => identitySubject(mediaIdentity(media), scope)), claims: noClaims, dryRun: false });
  const result: SiteMediaPurgeResult = {
    records: records.length,
    objects_deleted: objectsDeleted,
    records_removed: 0,
    records_retained: 0,
    failed: [],
    public_copies: publicCopiesSummary(copies),
  };
  for (const media of records) {
    const privateFailures = failedPrivate.get(media.id) ?? [];
    const publicFailures = [...copies.objects.filter(object => object.media_id === media.id && object.status === 'failed').map(object => ({ key: object.key, reason: object.reason ?? 'Unknown error' })),
      ...copies.errors.filter(error => error.media_id === media.id).map(error => ({ key: error.key, reason: error.reason }))];
    if (privateFailures.length || publicFailures.length) {
      result.records_retained += 1;
      for (const failure of privateFailures) result.failed.push({ media_id: media.id, ...failure });
      for (const failure of publicFailures) result.failed.push({ media_id: media.id, source: 'public_copy', ...failure });
      continue;
    }
    await store.deleteDoc(`${paths.media(orgId, siteId)}/${media.id}`);
    result.records_removed += 1;
  }
  return result;
}

export interface PublishedCopyRemovalInput {
  media_ids?: unknown;
  urls?: unknown;
  dry_run?: unknown;
  scan_publications?: unknown;
}

const MAX_REMOVAL_MEDIA_IDS = 100;
const MAX_REMOVAL_URLS = 500;

const URL_REFUSALS: Record<UrlRefusal | 'not_a_media_copy', string> = {
  invalid_url: 'Not an absolute http(s) URL without credentials, port, query or fragment.',
  foreign_host: 'The host is not one of this site\'s media hosts.',
  website_host: 'This host serves media from the website deployment, not from the public bucket; the next publication removes it.',
  unsafe_path: 'The path is not a valid media path.',
  foreign_prefix: 'The path is outside this site\'s media prefix.',
  reserved_path: 'The path is not a media copy (live files, publication markers and preparations are never removed here).',
  not_a_media_copy: 'The file name is not a published media copy of this site.',
};

/**
 * Remove published copies of media that is already deleted, by media id
 * and/or exact public URL: the API and MCP door for cleanup that the delete
 * of a record did not do (records deleted before deletion removed copies), or
 * could not finish (a tombstone left `pending`).
 *
 * Copies are found from the tombstones of deleted records and from the media
 * manifests of this site's publications. A URL must be on one of this site's
 * media hosts, under its media prefix, and be a media copy. Nothing an
 * existing media record still claims is touched — refer to it with
 * delete_media instead; copies used only by publications are removed, which is
 * the point. `dry_run` lists exactly what would be removed. Idempotent: a
 * second run finds nothing more to remove, and purges what a previous run
 * removed without purging.
 */
export async function removePublishedMediaCopies(orgId: string, siteId: string, input: PublishedCopyRemovalInput, options: { actor?: string | null } = {}): Promise<MediaItemDeletion> {
  const ids = input.media_ids === undefined ? [] : input.media_ids;
  const urls = input.urls === undefined ? [] : input.urls;
  if (!Array.isArray(ids) || !ids.every(validMediaId) || ids.length > MAX_REMOVAL_MEDIA_IDS) throw new ConnectionError(`media_ids must be an array of at most ${MAX_REMOVAL_MEDIA_IDS} media ids.`, 400, 'invalid_media_ids');
  if (!Array.isArray(urls) || !urls.every(url => typeof url === 'string' && url.length <= 2048) || urls.length > MAX_REMOVAL_URLS) throw new ConnectionError(`urls must be an array of at most ${MAX_REMOVAL_URLS} absolute URLs.`, 400, 'invalid_urls');
  if (!ids.length && !urls.length) throw new ConnectionError('Name the deleted media: media_ids, urls, or both.', 400, 'removal_target_required');
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') throw new ConnectionError('dry_run must be true or false.', 400);
  if (input.scan_publications !== undefined && typeof input.scan_publications !== 'boolean') throw new ConnectionError('scan_publications must be true or false.', 400);
  const dryRun = input.dry_run === true;
  const store = getStore();
  const [scope, records] = await Promise.all([copyScope(orgId, siteId), store.listDocs<Media>(paths.media(orgId, siteId))]);
  const existing = new Set(records.map(record => record.id));
  const mediaReport: Array<{ media_id: string; status: 'found' | 'not_found' | 'refused'; found_in?: string[]; code?: string; message?: string; state?: string }> = [];
  const deleted = [...new Set(ids as string[])].filter(id => {
    if (!existing.has(id)) return true;
    mediaReport.push({ media_id: id, status: 'refused', code: 'media_exists', message: 'This media record still exists. Delete it with delete_media, which removes its copies too.' });
    return false;
  });
  const tombstones = new Map<string, MediaRemovalRecord>();
  for (const id of deleted) {
    const tombstone = await store.getDoc<MediaRemovalRecord>(mediaRemovalPath(orgId, siteId, id));
    if (tombstone) tombstones.set(id, tombstone);
  }
  const scan = input.scan_publications === false ? { hits: new Map(), scanned: 0, unreadable: 0, skipped: 0 } : await scanPublicationMedia(orgId, siteId, new Set(deleted), scope);
  // Every existing record is protected; none is being removed here. Claimed after
  // the scan, which may add media hosts the records' addresses are on.
  const claims = existingClaims(records, scope, new Set());

  const subjects: CopySubject[] = [];
  const knownBases = new Set<string>();
  const identities = new Map<string, MediaIdentity>();
  for (const id of deleted) {
    const tombstone = tombstones.get(id);
    const hits = scan.hits.get(id) ?? [];
    const subject = tombstone ? identitySubject(tombstone.identity, scope) : emptySubject(id);
    const aliases = new Set<string>(tombstone ? identityUrls(tombstone.identity) : []);
    let sha256 = tombstone?.identity.sha256;
    for (const hit of hits) {
      for (const key of hit.public_keys) subject.bases.add(splitCopyKey(key).base);
      for (const url of hit.urls) aliases.add(url);
      if (hit.source_key) subject.private_keys.add(hit.source_key);
      if (hit.sha256) { subject.prepared_shas.add(hit.sha256); sha256 ??= hit.sha256; }
    }
    for (const base of subject.bases) knownBases.add(base);
    const foundIn = [...(tombstone ? ['tombstone'] : []), ...(hits.length ? ['publications'] : [])];
    mediaReport.push({ media_id: id, status: foundIn.length ? 'found' : 'not_found', found_in: foundIn,
      ...(foundIn.length ? {} : { message: 'No tombstone and no publication of this site lists this media id. Remove its copies by URL.' }) });
    if (!foundIn.length) continue;
    subjects.push(subject);
    identities.set(id, tombstone?.identity ?? { id, ...(sha256 ? { sha256 } : {}), source_aliases: [...aliases] });
  }

  const urlReport: Array<{ url: string; status: string; key?: string; code?: string; message?: string; referenced_by?: string }> = [];
  const urlSubject = emptySubject(null);
  const explicit = new Map<string, string>();
  for (const url of [...new Set(urls as string[])]) {
    const mapped = keyForUrl(url, scope);
    if ('refused' in mapped) { urlReport.push({ url, status: 'refused', code: mapped.refused, message: URL_REFUSALS[mapped.refused] }); continue; }
    const base = splitCopyKey(mapped.key).base;
    if (!knownBases.has(base) && !/^[a-f0-9]{16}-[A-Za-z0-9._-]+$/.test(base.split('/').pop() ?? '')) {
      urlReport.push({ url, status: 'refused', key: mapped.key, code: 'not_a_media_copy', message: URL_REFUSALS.not_a_media_copy });
      continue;
    }
    explicit.set(url, mapped.key);
    urlSubject.public_keys.add(mapped.key);
  }
  if (urlSubject.public_keys.size) subjects.push(urlSubject);

  const claimedUrl = (key: string) => claims.bases.get(splitCopyKey(key).base);
  const alwaysPurge = [...[...explicit].filter(([, key]) => !claimedUrl(key)).map(([url]) => url), ...[...tombstones.values()].flatMap(tombstone => tombstone.unpurged_urls)];
  const copies = await removeCopies(orgId, siteId, { scope, subjects, claims, dryRun, alwaysPurge });

  // Private objects a tombstone still points at (the record's own storage keys).
  const privateObjects: Record<string, MediaDeletionResult | { would_remove: string[] }> = {};
  for (const [id, tombstone] of tombstones) {
    privateObjects[id] = dryRun ? { would_remove: mediaObjects(tombstone.identity as Media).filter(object => !claims.private_keys.has(object.key)).map(object => object.key) }
      : await deleteMediaObjects(orgId, tombstone.identity as Media, { claims });
  }

  for (const [url, key] of explicit) {
    const object = copies.objects.find(candidate => candidate.bucket === 'public' && candidate.key === key);
    const failure = copies.errors.find(error => error.key === key);
    urlReport.push({ url, key, status: failure ? 'failed' : object ? object.status : 'absent',
      ...(object?.referenced_by ? { referenced_by: object.referenced_by, message: 'An existing media record still uses this file; it was kept.' } : {}),
      ...(object?.reason || failure ? { message: object?.reason ?? failure!.reason } : {}) });
  }
  if (!dryRun) {
    for (const id of identities.keys()) {
      const previous = tombstones.get(id);
      const now = new Date().toISOString();
      const tombstone: MediaRemovalRecord = previous ?? { media_id: id, state: 'pending', identity: identities.get(id)!, created_at: now, updated_at: now, attempts: 0, unpurged_urls: [], deleted_by: options.actor ?? null };
      const privateResult = privateObjects[id];
      const saved = await updateTombstone(orgId, siteId, tombstone, copies, privateResult && 'deleted' in privateResult ? privateResult : undefined);
      const entry = mediaReport.find(item => item.media_id === id);
      if (entry) entry.state = saved.state;
    }
  }

  const referenceUrls = [...copies.urls, ...explicit.keys(), ...[...identities.values()].flatMap(identityUrls)];
  const references = await referencesOrNote(orgId, siteId, { urls: referenceUrls, mediaIds: deleted });
  const publicCopies = publicCopiesSummary(copies, dryRun);
  const touched = dryRun ? publicCopies.would_remove!.length : publicCopies.removed.length;
  const warnings = [...referenceWarnings(references, touched, dryRun), ...('unavailable' in references ? [references.unavailable] : []), ...copies.cache.unavailable.map(entry => entry.message)];
  if (scan.unreadable) warnings.push(`${scan.unreadable} publication snapshot(s) could not be read; copies only they listed were not found. Name those copies by URL.`);
  if (scan.skipped) warnings.push(`Only the newest ${scan.scanned} publications were read (${scan.skipped} older ones were skipped). Name copies only older publications listed by URL.`);
  const privateFailed = Object.values(privateObjects).some(result => 'failed' in result && result.failed.length > 0);
  return {
    status: removalIncomplete(copies) || privateFailed ? 207 : 200,
    body: {
      dry_run: dryRun, media_prefix: scope.prefix, media_hosts: [...scope.hosts.keys()],
      publications: { scanned: scan.scanned, unreadable: scan.unreadable, skipped: scan.skipped },
      media: mediaReport, urls: urlReport, objects: copies.objects,
      public_copies: publicCopies, private_copies: privateCopiesSummary(copies, dryRun), private_objects: privateObjects,
      cache: copies.cache, references, warnings,
    },
  };
}
