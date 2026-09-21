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

import { paths, type Media } from '@typeroll/shared';
import { getStore } from './datastore';
import { storageClient } from './publishing/media-storage';

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
}

/** Delete one object, resolving the client for wherever it lives. */
async function deleteObject(orgId: string, object: MediaObject): Promise<void> {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  if (object.location) {
    const client = await storageClient(orgId, object.location);
    await client.send(new DeleteObjectCommand({ Bucket: object.location.bucket, Key: object.key }));
    return;
  }
  const { S3Client } = await import('@aws-sdk/client-s3');
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error('Managed media storage is not configured');
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
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
export async function deleteMediaObjects(orgId: string, media: Media): Promise<MediaDeletionResult> {
  const result: MediaDeletionResult = { deleted: 0, failed: [] };
  for (const object of mediaObjects(media)) {
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

export interface SiteMediaPurgeResult {
  records: number;
  objects_deleted: number;
  records_removed: number;
  /** Records deliberately kept because their objects could not be removed. */
  records_retained: number;
  failed: Array<{ media_id: string; key: string; source: MediaObject['source']; reason: string }>;
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
 * Re-runnable by construction — a second call retries exactly the records
 * whose objects did not go.
 */
export async function purgeSiteMedia(orgId: string, siteId: string): Promise<SiteMediaPurgeResult> {
  const store = getStore();
  const records = await store.listDocs<Media>(paths.media(orgId, siteId));
  const result: SiteMediaPurgeResult = {
    records: records.length,
    objects_deleted: 0,
    records_removed: 0,
    records_retained: 0,
    failed: [],
  };

  for (const media of records) {
    const outcome = await deleteMediaObjects(orgId, media);
    result.objects_deleted += outcome.deleted;
    if (outcome.failed.length > 0) {
      result.records_retained += 1;
      for (const failure of outcome.failed) result.failed.push({ media_id: media.id, ...failure });
      continue;
    }
    await store.deleteDoc(`${paths.media(orgId, siteId)}/${media.id}`);
    result.records_removed += 1;
  }
  return result;
}
