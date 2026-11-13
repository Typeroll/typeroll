// Published copies of media in the organization's PUBLIC R2 bucket.
//
// A publication does not serve a media record's private object. The build
// engine writes immutable copies into the organization's public bucket under
// the site's media prefix (`media/<site.media_id>/…`): the file itself, its
// responsive `.v2.<slot>.<hash>.webp|avif` variants, their receipts, the
// publication receipt and, for share images, an og:image copy — once per
// address the file was served at (the organization media host and the site's
// own media host map to different keys). They are kept for earlier
// publications and nothing else ever removed them: deleting the record removed
// its private objects only, and the next publication does not touch them
// either. A deleted photo stayed public, and Cloudflare's cache could keep
// serving it even after the object was gone (the copies are published with a
// one-year cache lifetime).
//
// This module finds those copies exactly, removes them and purges the cache
// for every URL they were served at:
//
// - The base keys of a media item come from its own published addresses
//   (`source_aliases`, which every publication extends with each URL it
//   served), the key its default name maps to, and — for records that are
//   already gone — the media manifests frozen into the site's publications.
// - Each base key is LISTED in the bucket and only the base object and the
//   recognised derived suffixes are taken. Nothing is matched by name. Any
//   other key under a base (an older derived format, or another name that
//   starts with this one) is never removed automatically: it is reported as
//   `unrecognized` for manual review and the removal counts as incomplete.
// - An object stays when an existing media record still claims it: the same
//   bytes imported twice publish once and share their copies (AT-14).
// - Explicit URLs must be on one of this site's media hosts, under this
//   site's media prefix, and look like a media copy.
// - Removed URLs are purged on every media host of the site. A connection
//   without Cloudflare's optional `cache.purge` permission (or a zone it
//   cannot reach) is reported as `purge_unavailable`, never swallowed.
// - Optionally (`purge_prefixes`) each base is also purged by URL prefix on
//   every media host, which covers query-string variants and derived URLs
//   nobody recorded. Prefix purge is tried after the file purge; when the zone
//   refuses it the file purge stands and the report says so.
// - Publications are read in batches (PUBLICATION_SCAN_BATCH snapshots per
//   call) so one call stays within a Worker's subrequest budget; the scan
//   returns `remaining` and a `next` cursor to continue from.

import { paths, type Media, type Redirect } from '@typeroll/shared';
import { AwsClient } from 'aws4fetch';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { ConnectionError, getConnection } from '../publishing/connections';
import { getOrganizationDomains, getSiteDomains, publicMediaPath, type PublicationHosts } from '../publishing/domain-config';
import { MEDIA_RECIPE_VERSION } from '../../../../../scripts/fixtures/static-publication/media-recipe.mjs';

/** The identity of a media item, from its record or from the tombstone that replaced it. */
export interface MediaIdentity {
  id: string;
  filename?: string;
  sha256?: string;
  public_path?: string | null;
  cdn_url?: string;
  published_url?: string | null;
  source_aliases?: string[];
  variants?: Array<{ cdn_url: string }>;
  mime_type?: string;
  storage?: Media['storage'];
  r2_key?: string;
  migration_source?: Media['migration_source'];
}

type HostKind = 'organization' | 'site';

/** Where this site's media is published: its key prefix and the media hosts that serve the public bucket. */
export interface CopyScope {
  prefix: string;
  /** `organization`: the shared host serves `/<key>`. `site`: a site media host serves `/<key minus prefix>`. */
  hosts: Map<string, HostKind>;
  /** Hosts where media was served from the website deployment itself (not the public bucket). */
  website_hosts: Set<string>;
}

/** The organization's buckets, reachable with its stored R2 access keys. */
export interface PublicCopyStorage {
  public_bucket: string;
  original_bucket: string;
  list(bucket: string, prefix: string): Promise<string[]>;
  remove(bucket: string, key: string): Promise<void>;
}

export interface CachePurger {
  purge(urls: string[]): Promise<void>;
  /** Purge by URL prefix (`host/path`, no scheme). Absent when the connection cannot. */
  purgePrefixes?(prefixes: string[]): Promise<void>;
}

/** Cloudflare purges at most this many URLs per request on every plan. */
export const PURGE_URLS_PER_REQUEST = 30;
/** Prefixes per purge request; kept at the URL limit, the lowest any plan allows. */
export const PURGE_PREFIXES_PER_REQUEST = 30;
/**
 * Publication snapshots read per call when discovering copies of records that
 * are already deleted. Each snapshot is several reads, so one call stays well
 * inside a Worker's subrequest budget; the scan returns a cursor to continue.
 */
export const PUBLICATION_SCAN_BATCH = 25;

// Suffixes the build writes beside a base object (lib/publishing/r2-build-grants.ts):
// responsive variants and their receipts, the publication receipt, and share copies.
const DERIVED_SUFFIX = /(\.v\d+\.(?:w\d+|original)\.[a-f0-9]{16}\.(?:webp|avif)(?:\.receipt\.json)?|\.prepared-v\d+\.[a-f0-9]{64}\.json|\.share-s\d+\.(?:photo\.[a-f0-9]{16}\.jpg|card\.[a-f0-9]{16}\.[0-9a-f]{6}\.png)(?:\.receipt\.json)?)$/;
/** The default published name, `<first 16 hex of sha256>-<sanitized filename>`. */
const DEFAULT_COPY_NAME = /^[a-f0-9]{16}-[A-Za-z0-9._-]+$/;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The base object a key belongs to, and the derived suffix that was stripped ('' for the base itself). */
export function splitCopyKey(key: string): { base: string; suffix: string } {
  const match = key.match(DERIVED_SUFFIX);
  return match ? { base: key.slice(0, -match[1]!.length), suffix: match[1]! } : { base: key, suffix: '' };
}

/** Keys under the prefix that are not media copies: live files, publication markers, cache-only preparations. */
function reservedKey(scope: CopyScope, key: string): boolean {
  const rest = key.slice(scope.prefix.length + 1);
  return /^(?:live|prepared|\.well-known|_typeroll)(?:\/|$)/.test(rest);
}

export async function copyScope(orgId: string, siteId: string): Promise<CopyScope> {
  const [prefix, organization, site] = await Promise.all([siteMediaPrefix(orgId, siteId), getOrganizationDomains(orgId), getSiteDomains(orgId, siteId)]);
  const scope: CopyScope = { prefix, hosts: new Map(), website_hosts: new Set() };
  if (organization.media_host) scope.hosts.set(organization.media_host, 'organization');
  const configured: Array<PublicationHosts | null | undefined> = [site.desired, site.active, site.published?.hosts, ...(site.media_aliases ?? [])];
  for (const hosts of configured) {
    if (!hosts?.media_host) continue;
    if (hosts.media_host === hosts.website_host) { scope.website_hosts.add(hosts.media_host); continue; }
    if (!scope.hosts.has(hosts.media_host)) scope.hosts.set(hosts.media_host, 'site');
  }
  return scope;
}

export type UrlRefusal = 'invalid_url' | 'foreign_host' | 'website_host' | 'unsafe_path' | 'foreign_prefix' | 'reserved_path';

/** The public-bucket key a URL on one of this site's media hosts serves. */
export function keyForUrl(input: string, scope: CopyScope): { key: string } | { refused: UrlRefusal } {
  let url: URL;
  try { url = new URL(input); } catch { return { refused: 'invalid_url' }; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash) return { refused: 'invalid_url' };
  const kind = scope.hosts.get(url.hostname);
  if (!kind) return { refused: scope.website_hosts.has(url.hostname) ? 'website_host' : 'foreign_host' };
  try { publicMediaPath(url.pathname); } catch { return { refused: 'unsafe_path' }; }
  const key = kind === 'organization' ? url.pathname.slice(1) : `${scope.prefix}${url.pathname}`;
  if (!key.startsWith(`${scope.prefix}/`) || key.length <= scope.prefix.length + 1) return { refused: 'foreign_prefix' };
  if (reservedKey(scope, key)) return { refused: 'reserved_path' };
  return { key };
}

/** Every URL a public-bucket key is served at on this site's media hosts. */
export function urlsForKey(key: string, scope: CopyScope): string[] {
  if (!key.startsWith(`${scope.prefix}/`)) return [];
  return [...scope.hosts].map(([host, kind]) => kind === 'organization' ? `https://${host}/${key}` : `https://${host}${key.slice(scope.prefix.length)}`);
}

/** The key a record's default published name maps to (`<sha16>-<name>`, or its chosen public path). */
function defaultBases(identity: MediaIdentity, scope: CopyScope): string[] {
  const bases: string[] = [];
  if (identity.public_path) {
    try { publicMediaPath(identity.public_path); bases.push(`${scope.prefix}${identity.public_path}`); } catch { /* unsafe paths were never published */ }
  }
  // Also with a chosen path: earlier publications may have used the default name.
  if (identity.sha256 && /^[a-f0-9]{64}$/.test(identity.sha256) && identity.filename) {
    bases.push(`${scope.prefix}/${identity.sha256.slice(0, 16)}-${identity.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  }
  return bases;
}

/** Every public URL a media identity recorded. */
export function identityUrls(identity: MediaIdentity): string[] {
  return [identity.cdn_url, identity.published_url ?? undefined, ...(identity.source_aliases ?? []), ...(identity.variants ?? []).map(variant => variant.cdn_url)]
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

/** Base keys of the copies a media identity has (or would have) in the public bucket. */
export function identityBases(identity: MediaIdentity, scope: CopyScope): Set<string> {
  const bases = new Set<string>();
  for (const url of identityUrls(identity)) {
    const mapped = keyForUrl(url, scope);
    if ('key' in mapped) bases.add(splitCopyKey(mapped.key).base);
  }
  // Without any media host nothing can have been published to the bucket.
  if (scope.hosts.size || bases.size) for (const base of defaultBases(identity, scope)) bases.add(base);
  return bases;
}

/** What existing media records still claim: their copies, private objects and prepared bytes stay. */
export interface Claims {
  bases: Map<string, string>;
  private_keys: Map<string, string>;
  shas: Map<string, string>;
}

export function existingClaims(records: Media[], scope: CopyScope, removing: Set<string>): Claims {
  const claims: Claims = { bases: new Map(), private_keys: new Map(), shas: new Map() };
  for (const record of records) {
    if (removing.has(record.id)) continue;
    for (const base of identityBases(record, scope)) if (!claims.bases.has(base)) claims.bases.set(base, record.id);
    const variantKeys = (record.variants ?? []).map(variant => { try { return new URL(variant.cdn_url).pathname.replace(/^\/+/, ''); } catch { return undefined; } });
    for (const key of [record.storage?.key, record.r2_key, record.migration_source?.key, ...variantKeys]) if (key && !claims.private_keys.has(key)) claims.private_keys.set(key, record.id);
    if (record.sha256 && !claims.shas.has(record.sha256)) claims.shas.set(record.sha256, record.id);
  }
  return claims;
}

function claimedBy(claims: Claims, bucket: 'public' | 'private', key: string): string | null {
  if (bucket === 'public') return claims.bases.get(splitCopyKey(key).base) ?? null;
  const prepared = key.match(/\/prepared\/[^/]+\/([a-f0-9]{64})\//);
  return claims.private_keys.get(key) ?? (prepared ? claims.shas.get(prepared[1]!) ?? null : null);
}

/** One media item (or none, for explicit URLs) and what to look for. */
export interface CopySubject {
  media_id: string | null;
  /** Public base keys; each is listed and its derived objects are included. */
  bases: Set<string>;
  /** Exact public keys (explicit URLs, manifest keys). */
  public_keys: Set<string>;
  /** Exact private keys in the organization's originals bucket (manifest source keys). */
  private_keys: Set<string>;
  /** Content hashes whose prepared variants (`private/<prefix>/prepared/<recipe>/<sha>/`) are removed. */
  prepared_shas: Set<string>;
}

export function emptySubject(mediaId: string | null): CopySubject {
  return { media_id: mediaId, bases: new Set(), public_keys: new Set(), private_keys: new Set(), prepared_shas: new Set() };
}

export interface CopyObjectResult {
  bucket: 'public' | 'private';
  key: string;
  media_id: string | null;
  /**
   * `unrecognized`: listed under one of the media's base keys, but neither the
   * base object nor a derived suffix the build writes. Never removed
   * automatically; review it and remove it by URL if it is a copy.
   */
  status: 'would_remove' | 'removed' | 'failed' | 'protected' | 'unrecognized';
  urls?: string[];
  referenced_by?: string;
  reason?: string;
  /** For `unrecognized`: the base key it was listed under. */
  base?: string;
}

export interface CachePurgeReport {
  purged: Array<{ host: string; urls: number }>;
  unavailable: Array<{ host: string; code: string; message: string; urls: number }>;
  failed: Array<{ host: string; reason: string; urls: number }>;
  /** URLs whose cache was not purged; a retry purges them. */
  pending_urls: string[];
  /**
   * Prefix purge per host, when asked for: `prefix` when the zone purged the
   * prefixes, `files` when it refused them (the file purge of every known URL
   * stands), `skipped` when the file purge for the host did not complete.
   */
  prefixes: Array<{ host: string; prefixes: number; method: 'prefix' | 'files' | 'skipped'; reason?: string }>;
}

const emptyCacheReport = (): CachePurgeReport => ({ purged: [], unavailable: [], failed: [], pending_urls: [], prefixes: [] });

export interface CopyRemovalResult {
  objects: CopyObjectResult[];
  /** Lookups that could not run (listing a key, reaching storage). */
  errors: Array<{ media_id: string | null; key: string; reason: string }>;
  cache: CachePurgeReport;
  /** Every URL that served (or would serve) a removed copy, for reference warnings. */
  urls: string[];
}

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unknown error';

/** Replaceable in offline tests; the defaults use the organization's stored Cloudflare connection. */
export const publicCopyRuntime = {
  storage: (orgId: string): Promise<PublicCopyStorage> => connectedStorage(orgId),
  purger: (orgId: string, siteId: string, host: string): Promise<CachePurger> => zonePurger(orgId, siteId, host),
};

async function connectedStorage(orgId: string): Promise<PublicCopyStorage> {
  const connection = await getConnection(orgId, 'cloudflare');
  const cf = connection.cloudflare;
  if (!connection.media_ready || !cf?.public_bucket || !cf.bucket || !connection.encrypted_credentials) {
    throw new ConnectionError('The organization’s R2 storage is not connected, so published copies cannot be reached. Reconnect storage in Publishing, then retry.', 409, 'media_storage_unavailable');
  }
  const { storageClient } = await import('../publishing/media-storage');
  const { DeleteObjectCommand } = await import('../net/s3');
  const client = await storageClient(orgId, { provider: 'organization_r2', account_id: cf.account_id, bucket: cf.bucket });
  const aws = new AwsClient({ accessKeyId: client.config.credentials.accessKeyId, secretAccessKey: client.config.credentials.secretAccessKey, service: 's3', region: 'auto', retries: 2 });
  return {
    public_bucket: cf.public_bucket,
    original_bucket: cf.bucket,
    list: (bucket, prefix) => listKeys(aws, client.url(bucket, ''), prefix),
    remove: async (bucket, key) => { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}

const xmlText = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** ListObjectsV2 under an exact prefix (the S3 shim covers single-object calls only). */
export async function listKeys(aws: Pick<AwsClient, 'fetch'>, bucketUrl: URL, prefix: string, maxPages = 20): Promise<string[]> {
  const keys: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(bucketUrl.toString());
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (token) url.searchParams.set('continuation-token', token);
    const response = await aws.fetch(url.toString(), { method: 'GET' });
    const text = await response.text();
    if (!response.ok) throw new Error(`Listing ${prefix} failed (HTTP ${response.status}${/<Code>([^<]+)<\/Code>/.exec(text)?.[1] ? `, ${/<Code>([^<]+)<\/Code>/.exec(text)![1]}` : ''})`);
    for (const match of text.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)) keys.push(xmlText(match[1]!));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) return keys;
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)?.[1] ?? null;
    if (!token) return keys;
    token = xmlText(token);
  }
  throw new Error(`Listing ${prefix} returned more than ${maxPages} pages`);
}

async function zonePurger(orgId: string, siteId: string, host: string): Promise<CachePurger> {
  const [{ hostingDns }, { siteHostingGroup }, { findPublishingZone }] = await Promise.all([
    import('../publishing/hosting-dns'), import('../publishing/hosting-groups'), import('../publishing/domain-provider')]);
  const group = await siteHostingGroup(orgId, siteId).catch(() => ({ id: 'default' }));
  const dns = await hostingDns(orgId, group.id, host);
  const zone = await findPublishingZone(dns.provider, dns.accountId, host);
  if (!/^[a-zA-Z0-9_-]+$/.test(zone.id)) throw new Error('Invalid cache zone');
  return {
    purge: async urls => { await dns.provider(`/zones/${zone.id}/purge_cache`, { method: 'POST', body: { files: urls } }); },
    // The same endpoint publication cache recovery uses (lib/publishing/cache-recovery.ts).
    purgePrefixes: async prefixes => { await dns.provider(`/zones/${zone.id}/purge_cache`, { method: 'POST', body: { prefixes } }); },
  };
}

/** `https://host/path` → `host/path`, the form Cloudflare's prefix purge takes. */
export function purgePrefix(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** Why a purge could not run, when the cause is access rather than a transient failure. */
function purgeUnavailable(host: string, error: unknown): { code: string; message: string } | null {
  const status = (error as { status?: unknown })?.status;
  const code = (error as { code?: unknown })?.code;
  if (status === 401 || status === 403 || code === 'publishing_cache_access_required') {
    return { code: 'cache_purge_permission_required', message: `Cloudflare refused to purge the cache for ${host}. Removed files can still be served from Cloudflare's cache until it expires (they were published with a one-year cache lifetime). Grant the optional Cache Purge permission: Publishing → Cloudflare account → Reconnect Cloudflare → approve Cache Purge for the account that holds ${host} (an API token needs Zone → Cache Purge). Then run remove_published_media_copies again with the same media_ids or urls.` };
  }
  if (code === 'domain_zone_required') {
    return { code: 'cache_zone_unavailable', message: `${host} is not in an active Cloudflare zone this organization's connection can manage, so its cache could not be purged. Purge the listed URLs at the DNS/CDN provider that serves ${host}, or connect DNS access in Publishing and run remove_published_media_copies again.` };
  }
  if (error instanceof ConnectionError && (error.status === 409 || error.status === 503)) {
    return { code: 'cache_purge_unavailable', message: `The cache for ${host} could not be purged: ${error.message}` };
  }
  return null;
}

/**
 * Purge `urls` per host, then (when given) `prefixes` (`host/path`, no
 * scheme). The file purge decides completeness: a URL it did not purge is
 * pending. A prefix purge the zone refuses falls back to that file purge and
 * is reported per host in `prefixes`.
 */
export async function purgeUrls(orgId: string, siteId: string, urls: string[], prefixes: string[] = []): Promise<CachePurgeReport> {
  const report = emptyCacheReport();
  const byHost = new Map<string, string[]>();
  const prefixesByHost = new Map<string, string[]>();
  for (const url of new Set(urls)) {
    const host = new URL(url).hostname;
    byHost.set(host, [...byHost.get(host) ?? [], url]);
  }
  for (const prefix of new Set(prefixes)) {
    const host = prefix.split('/')[0]!;
    if (!byHost.has(host)) byHost.set(host, []);
    prefixesByHost.set(host, [...prefixesByHost.get(host) ?? [], prefix]);
  }
  for (const [host, list] of byHost) {
    const hostPrefixes = prefixesByHost.get(host) ?? [];
    let done = 0;
    let purger: CachePurger;
    try {
      purger = await publicCopyRuntime.purger(orgId, siteId, host);
      for (let i = 0; i < list.length; i += PURGE_URLS_PER_REQUEST) {
        await purger.purge(list.slice(i, i + PURGE_URLS_PER_REQUEST));
        done = Math.min(list.length, i + PURGE_URLS_PER_REQUEST);
      }
      if (list.length) report.purged.push({ host, urls: list.length });
    } catch (error) {
      const remaining = list.slice(done);
      if (done) report.purged.push({ host, urls: done });
      const unavailable = purgeUnavailable(host, error);
      if (unavailable) report.unavailable.push({ host, ...unavailable, urls: remaining.length });
      else report.failed.push({ host, reason: errorText(error), urls: remaining.length });
      report.pending_urls.push(...remaining);
      if (hostPrefixes.length) report.prefixes.push({ host, prefixes: hostPrefixes.length, method: 'skipped', reason: 'The cache purge for this host did not complete.' });
      continue;
    }
    if (!hostPrefixes.length) continue;
    if (!purger.purgePrefixes) {
      report.prefixes.push({ host, prefixes: hostPrefixes.length, method: 'files', reason: 'This connection cannot purge by prefix.' });
      continue;
    }
    try {
      for (let i = 0; i < hostPrefixes.length; i += PURGE_PREFIXES_PER_REQUEST) await purger.purgePrefixes(hostPrefixes.slice(i, i + PURGE_PREFIXES_PER_REQUEST));
      report.prefixes.push({ host, prefixes: hostPrefixes.length, method: 'prefix' });
    } catch (error) {
      report.prefixes.push({ host, prefixes: hostPrefixes.length, method: 'files', reason: errorText(error) });
    }
  }
  return report;
}

/** What a removal found, before anything is deleted: callers record it first, so a Worker that dies mid-way leaves a retryable record. */
export interface CopyPlan {
  /** Objects found (`would_remove`, `protected`, `unrecognized`) and lookups that failed. */
  result: CopyRemovalResult;
  storage: PublicCopyStorage | null;
  /** Prefixes (`host/path`) to purge after the files, when a prefix purge was asked for. */
  prefixes: string[];
}

/**
 * Find and check every copy of the subjects without changing anything.
 * `purgePrefixes` also plans a prefix purge of every unclaimed base (and
 * explicit key) on every media host.
 */
export async function findCopies(orgId: string, _siteId: string, input: {
  scope: CopyScope; subjects: CopySubject[]; claims: Claims; purgePrefixes?: boolean;
}): Promise<CopyPlan> {
  const { scope, subjects, claims } = input;
  const result: CopyRemovalResult = { objects: [], errors: [], cache: emptyCacheReport(), urls: [] };
  const needsStorage = subjects.some(subject => subject.bases.size || subject.public_keys.size || subject.private_keys.size || subject.prepared_shas.size);
  let storage: PublicCopyStorage | null = null;
  if (needsStorage) {
    try { storage = await publicCopyRuntime.storage(orgId); }
    catch (error) {
      for (const subject of subjects) for (const key of [...subject.bases, ...subject.public_keys, ...subject.private_keys]) result.errors.push({ media_id: subject.media_id, key, reason: errorText(error) });
    }
  }
  const seen = new Set<string>();
  const add = (bucket: 'public' | 'private', key: string, mediaId: string | null) => {
    if (seen.has(`${bucket}:${key}`)) return;
    seen.add(`${bucket}:${key}`);
    const referenced = claimedBy(claims, bucket, key);
    result.objects.push({ bucket, key, media_id: mediaId, status: referenced ? 'protected' : 'would_remove',
      ...(bucket === 'public' ? { urls: urlsForKey(key, scope) } : {}), ...(referenced ? { referenced_by: referenced } : {}) });
  };
  // Keys under a base that are not its copies. Decided after every subject is
  // listed: such a key may be another subject's own base or copy.
  const strays: Array<{ key: string; base: string; media_id: string | null }> = [];
  if (storage) {
    const listings = new Map<string, Promise<string[]>>();
    const list = (bucket: string, prefix: string) => {
      const id = `${bucket}\n${prefix}`;
      if (!listings.has(id)) listings.set(id, storage!.list(bucket, prefix));
      return listings.get(id)!;
    };
    for (const subject of subjects) {
      const lookups: Array<{ bucket: 'public' | 'private'; prefix: string; base?: string; accept: (key: string) => boolean }> = [
        ...[...subject.bases].map(base => ({ bucket: 'public' as const, prefix: base, base, accept: (key: string) => splitCopyKey(key).base === base })),
        ...[...subject.public_keys].map(key => ({ bucket: 'public' as const, prefix: key, accept: (found: string) => found === key })),
        ...[...subject.private_keys].map(key => ({ bucket: 'private' as const, prefix: key, accept: (found: string) => found === key })),
        ...[...subject.prepared_shas].flatMap(sha => [...new Set(['v1', MEDIA_RECIPE_VERSION])].map(recipe => (
          { bucket: 'private' as const, prefix: `private/${scope.prefix}/prepared/${recipe}/${sha}/`, accept: () => true }))),
      ];
      for (const lookup of lookups) {
        try {
          const keys = await list(lookup.bucket === 'public' ? storage.public_bucket : storage.original_bucket, lookup.prefix);
          for (const key of keys) {
            if (lookup.accept(key)) add(lookup.bucket, key, subject.media_id);
            // Another existing record's file (its own base) is that record's business.
            else if (lookup.base && !reservedKey(scope, key) && !claimedBy(claims, 'public', key)) strays.push({ key, base: lookup.base, media_id: subject.media_id });
          }
        } catch (error) {
          result.errors.push({ media_id: subject.media_id, key: lookup.prefix, reason: errorText(error) });
        }
      }
    }
  }
  for (const stray of strays) {
    if (seen.has(`public:${stray.key}`)) continue;
    seen.add(`public:${stray.key}`);
    result.objects.push({ bucket: 'public', key: stray.key, media_id: stray.media_id, status: 'unrecognized', base: stray.base, urls: urlsForKey(stray.key, scope),
      reason: 'Listed under this media\'s published name, but not a copy the build writes. It was not removed; review it and remove it by URL if it is a copy of this media.' });
  }
  const prefixes = new Set<string>();
  if (input.purgePrefixes) {
    for (const subject of subjects) {
      for (const key of [...subject.bases, ...subject.public_keys]) {
        if (claimedBy(claims, 'public', key)) continue;
        for (const url of urlsForKey(key, scope)) prefixes.add(purgePrefix(url));
      }
    }
  }
  return { result, storage, prefixes: [...prefixes] };
}

/** Every URL a plan would remove a copy from: recorded as unpurged before anything is deleted. */
export function plannedUrls(plan: CopyPlan, mediaId?: string | null): string[] {
  return [...new Set(plan.result.objects.filter(object => object.bucket === 'public' && object.status === 'would_remove' && (mediaId === undefined || object.media_id === mediaId))
    .flatMap(object => object.urls ?? []))];
}

/** Every object a plan would remove, for a tombstone's `pending_keys`. */
export function plannedKeys(plan: CopyPlan, mediaId?: string | null): PendingKey[] {
  return plan.result.objects.filter(object => object.status === 'would_remove' && (mediaId === undefined || object.media_id === mediaId))
    .map(object => ({ bucket: object.bucket, key: object.key }));
}

/**
 * Remove what a plan found (unless `dryRun`), then purge the URLs the removed
 * copies were served at plus `alwaysPurge` (explicit URLs and URLs a previous
 * run removed without purging, so a retry finishes the job), then the plan's
 * prefixes.
 */
export async function applyCopyRemoval(orgId: string, siteId: string, plan: CopyPlan, input: { dryRun: boolean; alwaysPurge?: string[] }): Promise<CopyRemovalResult> {
  const { result, storage } = plan;
  if (storage && !input.dryRun) {
    for (const object of result.objects) {
      if (object.status !== 'would_remove') continue;
      try {
        await storage.remove(object.bucket === 'public' ? storage.public_bucket : storage.original_bucket, object.key);
        object.status = 'removed';
      } catch (error) {
        object.status = 'failed';
        object.reason = errorText(error);
      }
    }
  }
  const served = result.objects.filter(object => object.bucket === 'public' && (object.status === 'would_remove' || object.status === 'removed')).flatMap(object => object.urls ?? []);
  result.urls = [...new Set(served)];
  if (!input.dryRun) {
    const purge = [...new Set([...result.objects.filter(object => object.status === 'removed').flatMap(object => object.urls ?? []), ...input.alwaysPurge ?? []])];
    if (purge.length || plan.prefixes.length) result.cache = await purgeUrls(orgId, siteId, purge, plan.prefixes);
  }
  return result;
}

/** findCopies, then applyCopyRemoval, for callers that keep no record of their own between the two. */
export async function removeCopies(orgId: string, siteId: string, input: {
  scope: CopyScope; subjects: CopySubject[]; claims: Claims; dryRun: boolean; alwaysPurge?: string[]; purgePrefixes?: boolean;
}): Promise<CopyRemovalResult> {
  const plan = await findCopies(orgId, siteId, input);
  return applyCopyRemoval(orgId, siteId, plan, input);
}

/** The `public_copies` summary of a removal, as delete and the removal tool report it. */
export function publicCopiesSummary(result: CopyRemovalResult, dryRun = false) {
  const publicObjects = result.objects.filter(object => object.bucket === 'public');
  return {
    ...(dryRun ? { would_remove: publicObjects.filter(object => object.status === 'would_remove').map(object => object.key) } : {}),
    removed: publicObjects.filter(object => object.status === 'removed').map(object => object.key),
    failed: [...publicObjects.filter(object => object.status === 'failed').map(object => ({ key: object.key, reason: object.reason ?? 'Unknown error' })),
      ...result.errors.map(error => ({ key: error.key, reason: error.reason }))],
    protected: publicObjects.filter(object => object.status === 'protected').map(object => ({ key: object.key, referenced_by: object.referenced_by! })),
    unrecognized: unrecognizedByBase(result),
    purged: result.cache.purged,
    purge_unavailable: result.cache.unavailable,
    purge_failed: result.cache.failed,
    prefix_purge: result.cache.prefixes,
  };
}

/** Keys listed under a base that are not its copies, per base: they need a person's review. */
export function unrecognizedByBase(result: CopyRemovalResult): Array<{ base: string; media_id: string | null; keys: string[]; urls: string[] }> {
  const groups = new Map<string, { base: string; media_id: string | null; keys: string[]; urls: string[] }>();
  for (const object of result.objects) {
    if (object.status !== 'unrecognized') continue;
    const base = object.base ?? object.key;
    const group = groups.get(base) ?? { base, media_id: object.media_id, keys: [], urls: [] };
    group.keys.push(object.key);
    group.urls.push(...object.urls ?? []);
    groups.set(base, group);
  }
  return [...groups.values()];
}

/** The warning for unrecognized keys: which ones, and how to remove them after review. */
export function unrecognizedWarning(result: CopyRemovalResult): string | null {
  const groups = unrecognizedByBase(result);
  if (!groups.length) return null;
  return `${groups.reduce((sum, group) => sum + group.keys.length, 0)} object(s) under this media's published names are not copies Typeroll recognizes, so they were NOT removed and may still be public: ${groups.map(group => `${group.keys.join(', ')} (under ${group.base})`).join('; ')}. Review them manually. To remove one that is a copy of this media, run remove_published_media_copies with the media id and its URL from public_copies.unrecognized; until then the removal stays incomplete.`;
}

export function privateCopiesSummary(result: CopyRemovalResult, dryRun = false) {
  const privateObjects = result.objects.filter(object => object.bucket === 'private');
  return {
    ...(dryRun ? { would_remove: privateObjects.filter(object => object.status === 'would_remove').map(object => object.key) } : {}),
    removed: privateObjects.filter(object => object.status === 'removed').map(object => object.key),
    failed: privateObjects.filter(object => object.status === 'failed').map(object => ({ key: object.key, reason: object.reason ?? 'Unknown error' })),
    protected: privateObjects.filter(object => object.status === 'protected').map(object => ({ key: object.key, referenced_by: object.referenced_by! })),
  };
}

/** Whether anything is left: an object, a lookup, a cache purge, or a key that needs review. */
export function removalIncomplete(result: CopyRemovalResult): boolean {
  return result.errors.length > 0 || result.objects.some(object => object.status === 'failed' || object.status === 'unrecognized') || result.cache.pending_urls.length > 0;
}

// ─── Already-deleted media: tombstones and publication manifests ────────────

/** Kept after a media record is deleted, so cleanup of its copies stays retryable and auditable. */
export interface MediaRemovalRecord {
  media_id: string;
  state: 'pending' | 'complete';
  identity: MediaIdentity;
  created_at: string;
  updated_at: string;
  attempts: number;
  /**
   * URLs whose cache purge did not happen yet. Written with every URL a run
   * plans to remove BEFORE it deletes anything, and shrunk once the purge
   * succeeds, so a run that dies mid-way still purges them on retry.
   */
  unpurged_urls: string[];
  /**
   * Objects planned for removal and not confirmed removed yet, written before
   * anything is deleted. A retry looks each one up exactly, also when it was
   * found only through a publication scan.
   */
  pending_keys?: PendingKey[];
  last_result?: Record<string, unknown>;
  deleted_by?: string | null;
}

export interface PendingKey { bucket: 'public' | 'private'; key: string }

/** A tombstone lists at most this many pending keys; a listing finds the rest again. */
export const MAX_PENDING_KEYS = 1000;

export const mediaRemovalPath =(orgId: string, siteId: string, mediaId: string) => `${paths.site(orgId, siteId)}/media_removals/${mediaId}`;

export function validMediaId(value: unknown): value is string { return typeof value === 'string' && MEDIA_ID.test(value); }

/** Only the fields needed to find copies again; never content or credentials. */
export function mediaIdentity(media: Media): MediaIdentity {
  const { id, filename, sha256, public_path, cdn_url, published_url, source_aliases, variants, mime_type, storage, r2_key, migration_source } = media;
  return JSON.parse(JSON.stringify({ id, filename, sha256, public_path, cdn_url, published_url, source_aliases, mime_type, storage, r2_key, migration_source,
    variants: variants?.map(variant => ({ cdn_url: variant.cdn_url })) }));
}

export interface PublicationMediaHit { public_keys: string[]; urls: string[]; source_key?: string; sha256?: string; original_bucket?: string }
export interface PublicationScan {
  hits: Map<string, PublicationMediaHit[]>;
  scanned: number;
  unreadable: number;
  /** Older snapshots this call did not read; call again with `next` to read them. */
  remaining: number;
  /** Cursor for the next batch (`publications_after`), or null when every snapshot was read. */
  next: string | null;
}

type PublicationRef = { snapshot_job_id?: string; snapshot_chunks: number; snapshot_digest: string; snapshot_format?: 1 };

/** A scan cursor names the last snapshot read: `<created_at>~<snapshot digest>`. */
export function validScanCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300 && /^[^~]*~[A-Za-z0-9:._-]+$/.test(value);
}

/**
 * Media manifests frozen into this site's publications, for the given media
 * ids. Every publication is read (failed ones too: their build may have
 * written copies), newest first, at most `batch` distinct snapshots per call
 * starting after the `after` cursor; `remaining` and `next` say what is left.
 * A publication made between two calls is newer than the cursor and is not
 * read by the continuation; nothing older is skipped.
 */
export async function scanPublicationMedia(orgId: string, siteId: string, ids: Set<string>, scope: CopyScope, options: { batch?: number; after?: string | null } = {}): Promise<PublicationScan> {
  const scan: PublicationScan = { hits: new Map(), scanned: 0, unreadable: 0, remaining: 0, next: null };
  if (!ids.size) return scan;
  const batch = Math.max(1, options.batch ?? PUBLICATION_SCAN_BATCH);
  const { readSnapshot } = await import('../publishing/publication-snapshot');
  const jobs = await getStore().listDocs<{ id: string; created_at?: string; git_publication?: PublicationRef }>(paths.deploys(orgId, siteId));
  const refs = new Map<string, { jobId: string; ref: PublicationRef; createdAt: string }>();
  for (const job of jobs.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || a.id.localeCompare(b.id))) {
    const ref = job.git_publication;
    if (!ref?.snapshot_digest || refs.has(ref.snapshot_digest)) continue;
    refs.set(ref.snapshot_digest, { jobId: ref.snapshot_job_id ?? job.id, ref, createdAt: String(job.created_at ?? '') });
  }
  const ordered = [...refs.values()];
  let start = 0;
  if (options.after) {
    const split = options.after.lastIndexOf('~');
    const at = options.after.slice(0, split), digest = options.after.slice(split + 1);
    const index = ordered.findIndex(entry => entry.ref.snapshot_digest === digest);
    // The cursor's snapshot is gone: continue with everything older than it.
    const older = ordered.findIndex(entry => entry.createdAt < at);
    start = index >= 0 ? index + 1 : older >= 0 ? older : ordered.length;
  }
  const selected = ordered.slice(start, start + batch);
  scan.remaining = ordered.length - start - selected.length;
  const last = selected[selected.length - 1];
  scan.next = scan.remaining > 0 && last ? `${last.createdAt}~${last.ref.snapshot_digest}` : null;
  for (const { jobId, ref } of selected) {
    let snapshot: any;
    try { snapshot = await readSnapshot({ orgId, siteId, jobId }, ref); }
    catch { scan.unreadable++; continue; }
    scan.scanned++;
    for (const manifest of [snapshot?.media_manifest, ...(snapshot?.retained_media_manifests ?? [])]) {
      if (!manifest || manifest.site_prefix !== scope.prefix || !Array.isArray(manifest.entries)) continue;
      for (const entry of manifest.entries) {
        if (!ids.has(entry?.id)) continue;
        const pairs: Array<{ url?: string; key?: string }> = [{ url: entry.cdn_url, key: entry.public_key }, ...(entry.aliases ?? [])];
        for (const { url, key } of pairs) {
          // Learn hosts this site served media from, from the URL ↔ key pairs the build used.
          if (typeof url !== 'string' || typeof key !== 'string') continue;
          try {
            const host = new URL(url).hostname, pathname = new URL(url).pathname;
            if (scope.hosts.has(host)) continue;
            if (pathname.slice(1) === key) scope.hosts.set(host, 'organization');
            else if (`${scope.prefix}${pathname}` === key && manifest.delivery !== 'static' && manifest.media_host !== manifest.website_host) scope.hosts.set(host, 'site');
          } catch { /* not a URL */ }
        }
        const hit: PublicationMediaHit = {
          public_keys: pairs.map(pair => pair.key).filter((key): key is string => typeof key === 'string' && key.startsWith(`${scope.prefix}/`)),
          urls: pairs.map(pair => pair.url).filter((url): url is string => typeof url === 'string'),
          ...(typeof entry.source_key === 'string' && entry.source_key.startsWith(`private/${scope.prefix}/`) ? { source_key: entry.source_key } : {}),
          ...(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) ? { sha256: entry.sha256 } : {}),
          ...(typeof manifest.original_bucket === 'string' ? { original_bucket: manifest.original_bucket } : {}),
        };
        scan.hits.set(entry.id, [...scan.hits.get(entry.id) ?? [], hit]);
      }
    }
  }
  return scan;
}

// ─── References that will break ──────────────────────────────────────────────

export interface MediaReferences {
  redirects: Array<{ id: string; from_path: string; to_path: string; matched: 'target' | 'source' }>;
  content: Array<{ kind: 'page' | 'partial' | 'settings' | 'menu'; id: string; title?: string }>;
  content_total: number;
}

const CONTENT_REFERENCE_LIST_LIMIT = 50;

/**
 * Redirects and main-version content that still point at removed copies.
 * Nothing is changed: a redirect to a deleted image is the owner's decision.
 *
 * `urls` are public addresses (removed copies, published and source aliases);
 * `sourcePaths` are original addresses on other hosts (for example
 * `/wp-content/uploads/…` of a migrated file), matched against redirect sources.
 */
export async function findMediaReferences(orgId: string, siteId: string, input: { urls: string[]; mediaIds: string[] }): Promise<MediaReferences> {
  const store = getStore();
  const urls = new Set(input.urls.filter(Boolean));
  const bases = new Set<string>();
  const targetPaths = new Set<string>();
  const sourcePaths = new Set<string>();
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      const base = splitCopyKey(`${parsed.origin}${parsed.pathname}`).base;
      bases.add(base);
      targetPaths.add(splitCopyKey(parsed.pathname).base);
      sourcePaths.add(parsed.pathname);
    } catch { /* not a URL */ }
  }
  const references: MediaReferences = { redirects: [], content: [], content_total: 0 };
  const redirects = await store.listDocs<Redirect>(paths.redirects(orgId, siteId));
  for (const rule of redirects) {
    const target = typeof rule.to_path === 'string' ? rule.to_path.split(/[?#]/)[0]! : '';
    let hit: 'target' | 'source' | null = null;
    if (/^https?:\/\//.test(target)) { try { const parsed = new URL(target); if (bases.has(splitCopyKey(`${parsed.origin}${parsed.pathname}`).base)) hit = 'target'; } catch { /* invalid */ } }
    else if (target && targetPaths.has(splitCopyKey(target).base)) hit = 'target';
    if (!hit && typeof rule.from_path === 'string' && sourcePaths.has(rule.from_path.split(/[?#]/)[0]!)) hit = 'source';
    if (hit) references.redirects.push({ id: rule.id, from_path: rule.from_path, to_path: rule.to_path, matched: hit });
  }
  const needles = [...bases, ...input.mediaIds.flatMap(id => [`/media/${id}/content`, id])].filter(needle => needle.length >= 8);
  if (!needles.length) return references;
  const check = (kind: MediaReferences['content'][number]['kind'], doc: any) => {
    const serialized = JSON.stringify(doc);
    if (!needles.some(needle => serialized.includes(needle))) return;
    references.content_total++;
    if (references.content.length < CONTENT_REFERENCE_LIST_LIMIT) references.content.push({ kind, id: String(doc?.id ?? kind), ...(doc?.title || doc?.name ? { title: String(doc.title ?? doc.name) } : {}) });
  };
  const [pages, partials, menus, settings] = await Promise.all([
    store.listDocs<any>(paths.pages(orgId, siteId)), store.listDocs<any>(paths.partials(orgId, siteId)),
    store.listDocs<any>(paths.menus(orgId, siteId)), store.getDoc<any>(paths.settings(orgId, siteId))]);
  for (const page of pages) check('page', page);
  for (const partial of partials) check('partial', partial);
  for (const menu of menus) check('menu', menu);
  if (settings) check('settings', { ...settings, id: 'settings' });
  return references;
}

/** Warnings a delete or removal returns, so nobody has to guess what still points at the files. */
export function referenceWarnings(references: MediaReferences, removedPublic: number, dryRun = false): string[] {
  const warnings: string[] = [];
  if (references.redirects.length) {
    warnings.push(`${references.redirects.length} redirect(s) point at ${dryRun ? 'copies that would be removed' : 'removed copies'} or at the file's original addresses: ${references.redirects.map(rule => `${rule.id} (${rule.from_path} → ${rule.to_path})`).join(', ')}. They were not changed; update or delete them so they do not lead to a missing file.`);
  }
  if (references.content_total) {
    warnings.push(`${references.content_total} page(s), partial(s), menus or settings of the main version still reference this media: ${references.content.map(item => `${item.kind} ${item.id}${item.title ? ` (${item.title})` : ''}`).join(', ')}${references.content_total > references.content.length ? ', …' : ''}. Remove the references, then publish.`);
  }
  if (removedPublic) {
    warnings.push(`The live site still references the ${dryRun ? 'files that would be removed' : 'removed files'} until the next publication: pages that showed them show a missing image. Publish the site to remove the references.`);
  }
  return warnings;
}
