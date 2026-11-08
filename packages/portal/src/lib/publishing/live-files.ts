// Live files: small public JSON files a site keeps outside its publication
// (live snippets and live site fields), written the moment they are saved.
//
// Where they go. Published media is served from the organization's public
// R2 bucket (customer-owned publishing): the customer's build engine writes
// the immutable media objects there, under the site's anonymous namespace
// `media/<media_id>/`, and a media host serves the bucket:
//   - a site media host (media.<site domain>) maps `/<path>` to
//     `media/<media_id>/<path>` with a URL Rewrite Rule;
//   - the organization's shared media host serves the bucket root, so
//     `/media/<media_id>/<path>`.
// Live files use the same bucket and host, at `media/<media_id>/live/<name>.json`,
// so they reach visitors through the routing the site's images already use.
// Unlike media they change in place, so Core writes them itself with the
// connection's R2 keys (never through a build grant), with a short cache.
// A site whose media stays on its website host (no media host, a hosted site)
// has no place a file can change without a publication: liveBaseUrl answers
// null and snippets show the value of the latest publication.
//
// The browser reads the files from the site's own pages on another host, so
// the public bucket gets one CORS rule per site for GET and HEAD from that
// site's addresses. Portal previews never fetch them (render-preview:
// previewLiveContent): they render live content as saved and are sandboxed
// into an opaque origin, so the portal is not one of those addresses. The rule is merged into the bucket's existing rules,
// refreshed when the site's addresses change (checked before every write)
// and when the organization's media storage is prepared or connected.

import { createHash } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '../net/s3';
import { MAIN_VERSION_ID, paths, usesCustomerPublishing, type Site, type SiteVersion } from '@typeroll/shared';
import { getStore } from '../datastore';
import { siteMediaPrefix } from '../media-keys';
import { r2Endpoint } from '../r2-endpoint';
import { publishingRuntimeOrigins } from './runtime-origins';
import { getConnection, openCredentials, type Connection } from './connections';
import { activePublicationDomains, getOrganizationDomains, getSiteDomains } from './domain-config';
import type { CloudflareCredentials } from './cloudflare-connection';

export const LIVE_FILE_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=600';
/** The live file of a site's live fields. Snippet ids cannot start with `_`. */
export const LIVE_FIELDS_FILE = '_fields';
const NAME = /^(?:_fields|[a-z0-9][a-z0-9_-]{0,63})$/;

export type LiveUnavailableReason = 'site_not_found' | 'hosted_site' | 'media_storage_not_ready' | 'no_media_host';

export type LiveTarget =
  | { available: true; base_url: string; host: string; account_id: string; bucket: string; key_prefix: string }
  | { available: false; reason: LiveUnavailableReason; message: string };

export type LiveWriteResult =
  | { published: true; url: string; warning?: string }
  | { published: false; reason: string; code: LiveUnavailableReason | 'write_failed' };

const MESSAGES: Record<LiveUnavailableReason, string> = {
  site_not_found: 'The site was not found.',
  hosted_site: 'Hosted sites keep their media with the site, so live content changes at the next publication.',
  media_storage_not_ready: 'The organization\'s R2 media storage is not ready. Live content changes at the next publication until media storage is set up in Publishing.',
  no_media_host: 'The site has no media host, so live content changes at the next publication. Set a media host in Publishing to update it without publishing.',
};

const unavailable = (reason: LiveUnavailableReason): LiveTarget => ({ available: false, reason, message: MESSAGES[reason] });

function liveName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid live file name ${name}`);
  return name;
}

/**
 * Where this site's live files are published, or why they cannot be. Uses
 * the media hosts the site's publications serve images from.
 */
export async function liveFilesTarget(orgId: string, siteId: string): Promise<LiveTarget> {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  if (!site) return unavailable('site_not_found');
  if (!usesCustomerPublishing(site)) return unavailable('hosted_site');
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.status !== 'connected' || !connection.cloudflare?.public_bucket || !connection.cloudflare.account_id) return unavailable('media_storage_not_ready');
  const [domains, organization] = await Promise.all([getSiteDomains(orgId, siteId), getOrganizationDomains(orgId)]);
  const hosts = activePublicationDomains(domains).desired;
  const prefix = await siteMediaPrefix(orgId, siteId);
  const own = hosts.media_host && hosts.media_host !== hosts.website_host ? hosts.media_host : null;
  const host = own ?? organization.media_host;
  if (!host) return unavailable('no_media_host');
  const path = own ? '/live' : `/${prefix}/live`;
  return { available: true, base_url: `https://${host}${path}`, host, account_id: connection.cloudflare.account_id, bucket: connection.cloudflare.public_bucket, key_prefix: `${prefix}/live` };
}

/**
 * The public URL prefix of this site's live files (`<base>/<snippet id>.json`
 * and `<base>/_fields.json`), or null when the site has nowhere to serve
 * them; its snippets then show the value of the latest publication.
 */
export async function liveBaseUrl(orgId: string, siteId: string): Promise<string | null> {
  const target = await liveFilesTarget(orgId, siteId);
  return target.available ? target.base_url : null;
}

function r2Client(orgId: string, connection: Connection, bucket: string): S3Client | null {
  if (!connection.media_ready || !connection.encrypted_credentials || !connection.cloudflare) return null;
  const credentials = openCredentials<CloudflareCredentials>(orgId, 'cloudflare', connection.encrypted_credentials);
  if (!credentials.access_key_id || !credentials.secret_access_key || !/^[a-f0-9]{32}$/.test(connection.cloudflare.account_id)) return null;
  return new S3Client({ region: 'auto', endpoint: r2Endpoint(connection.cloudflare.account_id, bucket),
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key },
    forcePathStyle: true, maxAttempts: 2 });
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 200) : 'unknown error';
}

/** Writes `<name>.json`. A failure is returned, never thrown: the save that asked for it has already succeeded. */
export async function publishLiveFile(orgId: string, siteId: string, name: string, json: unknown, options: { fetchImpl?: typeof fetch } = {}): Promise<LiveWriteResult> {
  const file = liveName(name);
  let target: LiveTarget;
  try { target = await liveFilesTarget(orgId, siteId); }
  catch (error) { return { published: false, code: 'write_failed', reason: `The live file could not be written: ${errorText(error)}` }; }
  if (!target.available) return { published: false, code: target.reason, reason: target.message };
  const connection = await getConnection(orgId, 'cloudflare');
  const client = r2Client(orgId, connection, target.bucket);
  if (!client) return { published: false, code: 'media_storage_not_ready', reason: MESSAGES.media_storage_not_ready };
  let warning: string | undefined;
  try { await ensureLiveCors(orgId, siteId, { fetchImpl: options.fetchImpl }); }
  catch (error) {
    console.warn(`[live-files] site ${siteId}: CORS rule not updated`, errorText(error));
    warning = 'The live file was written, but the media bucket\'s CORS rule for this site could not be updated, so pages may keep showing the published value. Check the Cloudflare connection in Publishing.';
  }
  try {
    await client.send(new PutObjectCommand({ Bucket: target.bucket, Key: `${target.key_prefix}/${file}.json`, Body: JSON.stringify(json),
      ContentType: 'application/json; charset=utf-8', CacheControl: LIVE_FILE_CACHE_CONTROL }), { abortSignal: AbortSignal.timeout(15_000) });
  } catch (error) {
    console.warn(`[live-files] site ${siteId}: ${file}.json not written`, errorText(error));
    return { published: false, code: 'write_failed', reason: `The live file could not be written to the media bucket (${errorText(error)}). The saved content shows at the next publication; save again to retry.` };
  } finally { client.destroy(); }
  await getStore().setDoc(liveStatePath(orgId, siteId, 'files'), { ...(await liveFiles(orgId, siteId)), [file]: new Date().toISOString() }).catch(() => {});
  return { published: true, url: `${target.base_url}/${file}.json`, ...(warning ? { warning } : {}) };
}

/** Removes `<name>.json`; a missing file or unavailable storage is not an error. */
export async function deleteLiveFile(orgId: string, siteId: string, name: string): Promise<{ deleted: boolean; reason?: string }> {
  const file = liveName(name);
  const target = await liveFilesTarget(orgId, siteId).catch(() => null);
  if (!target?.available) return { deleted: false, reason: target ? target.message : 'The live file target could not be read.' };
  const client = r2Client(orgId, await getConnection(orgId, 'cloudflare'), target.bucket);
  if (!client) return { deleted: false, reason: MESSAGES.media_storage_not_ready };
  try {
    await client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: `${target.key_prefix}/${file}.json` }), { abortSignal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { deleted: false, reason: `The live file could not be removed (${errorText(error)}).` };
  } finally { client.destroy(); }
  const { [file]: _removed, ...rest } = await liveFiles(orgId, siteId);
  await getStore().setDoc(liveStatePath(orgId, siteId, 'files'), rest).catch(() => {});
  return { deleted: true };
}

// ─── CORS ─────────────────────────────────────────────────────────────────

function liveStatePath(orgId: string, siteId: string, doc: 'cors' | 'files'): string {
  return `${paths.site(orgId, siteId)}/live_files/${doc}`;
}

async function liveFiles(orgId: string, siteId: string): Promise<Record<string, string>> {
  const { id: _id, ...files } = (await getStore().getDoc<Record<string, string>>(liveStatePath(orgId, siteId, 'files'))) ?? { id: '' };
  return files as Record<string, string>;
}

/** The CORS rule id of one site in the organization's public bucket. */
export function liveCorsRuleId(siteId: string): string {
  return `typeroll-live-${createHash('sha256').update(siteId).digest('hex').slice(0, 16)}`;
}

function origin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return url.origin;
  } catch { /* an invalid stored address is left out */ }
  return null;
}

/**
 * The addresses the site's pages are served from: its verified publication
 * origins, its website hosts (current and switching) and the deploy
 * addresses of its versions. Not the portal, and never `null`: portal
 * previews render live content themselves and fetch no live files.
 */
export async function liveSiteOrigins(orgId: string, siteId: string): Promise<string[]> {
  const store = getStore();
  const [site, verified, domains, versions] = await Promise.all([
    store.getDoc<Site>(paths.site(orgId, siteId)), publishingRuntimeOrigins(orgId, siteId), getSiteDomains(orgId, siteId),
    store.listDocs<SiteVersion>(paths.versions(orgId, siteId)),
  ]);
  const candidates = [
    ...verified, site?.domain, site?.staging_url, site?.hosting_config?.fallback_subdomain,
    domains.desired.website_host, domains.active?.website_host, domains.published?.hosts.website_host,
    ...versions.filter((version) => version.id !== MAIN_VERSION_ID).map((version) => version.deploy_url),
  ];
  return [...new Set(candidates.map(origin).filter((value): value is string => Boolean(value)))].sort();
}

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
interface CorsRule { id?: string; allowed?: { origins?: string[]; methods?: string[]; headers?: string[] }; exposeHeaders?: string[]; maxAgeSeconds?: number }

function liveCorsRule(siteId: string, origins: string[]): CorsRule {
  return { id: liveCorsRuleId(siteId), allowed: { origins, methods: ['GET', 'HEAD'] }, maxAgeSeconds: 3600 };
}

/** Merges rules into the bucket's CORS policy, keeping every other rule as it is. */
async function putCorsRules(provider: Provider, accountId: string, bucket: string, rules: CorsRule[]): Promise<void> {
  const route = `/accounts/${accountId}/r2/buckets/${bucket}/cors`;
  const current = await provider(route, { missing: true });
  const ids = new Set(rules.map((rule) => rule.id));
  const existing: CorsRule[] = (current?.rules ?? []).filter((rule: CorsRule) => !ids.has(rule.id));
  await provider(route, { method: 'PUT', body: { rules: [...existing, ...rules.filter((rule) => rule.allowed?.origins?.length)] } });
}

/**
 * Makes sure the public bucket lets this site's addresses read its live
 * files. Reads the recorded rule first and calls Cloudflare only when the
 * addresses or the bucket changed (or with `force`).
 */
export async function ensureLiveCors(orgId: string, siteId: string, options: { force?: boolean; fetchImpl?: typeof fetch; provider?: Provider } = {}): Promise<boolean> {
  const target = await liveFilesTarget(orgId, siteId);
  if (!target.available) return false;
  const origins = await liveSiteOrigins(orgId, siteId);
  const state = await getStore().getDoc<{ bucket?: string; origins?: string[] }>(liveStatePath(orgId, siteId, 'cors'));
  if (!options.force && state?.bucket === target.bucket && JSON.stringify(state.origins ?? []) === JSON.stringify(origins)) return false;
  const provider = options.provider ?? await (await import('./cloudflare-oauth')).cloudflareClient(orgId, options.fetchImpl ?? fetch);
  await putCorsRules(provider, target.account_id, target.bucket, [liveCorsRule(siteId, origins)]);
  await getStore().setDoc(liveStatePath(orgId, siteId, 'cors'), { bucket: target.bucket, origins, applied_at: new Date().toISOString() });
  return true;
}

/**
 * Applies the live CORS rule of every site that has live content, in one
 * update of the bucket's policy. Run when media storage is prepared, so a
 * reconnected or recreated bucket serves live files again.
 */
export async function refreshOrganizationLiveCors(orgId: string, provider: Provider): Promise<number> {
  const sites = await getStore().listDocs<Site>(paths.sites(orgId));
  const rules: CorsRule[] = [];
  let target: Extract<LiveTarget, { available: true }> | null = null;
  for (const site of sites) {
    if (!(await hasLiveContent(orgId, site.id))) continue;
    const siteTarget = await liveFilesTarget(orgId, site.id);
    if (!siteTarget.available) continue;
    target = siteTarget;
    const origins = await liveSiteOrigins(orgId, site.id);
    rules.push(liveCorsRule(site.id, origins));
    await getStore().setDoc(liveStatePath(orgId, site.id, 'cors'), { bucket: siteTarget.bucket, origins, applied_at: new Date().toISOString() });
  }
  if (!target || !rules.length) return 0;
  await putCorsRules(provider, target.account_id, target.bucket, rules);
  return rules.length;
}

/** True when the site has snippets or has published a live file. */
export async function hasLiveContent(orgId: string, siteId: string): Promise<boolean> {
  if ((await getStore().listDocs(paths.snippets(orgId, siteId), { limit: 1 })).length) return true;
  return Object.keys(await liveFiles(orgId, siteId)).length > 0;
}
