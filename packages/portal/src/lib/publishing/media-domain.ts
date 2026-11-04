import { createHash } from 'node:crypto';
import { getConnection, ConnectionError } from './connections';
import { cloudflareClient } from './cloudflare-oauth';
import { findPublishingZone } from './domain-provider';
import { getOrganizationDomains } from './domain-config';
import { parsePublicHttpsUrl } from '../extensions/public-http';
import { safeFetch } from '../net/safe-fetch';
import { shareCopyTarget } from '../../../../../scripts/fixtures/static-publication/media-recipe.mjs';

const MAX_MEDIA_CHECK_BYTES = 25 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 8192;

export interface PublicMediaManifest {
  delivery?: string; account_id: string; public_bucket: string; media_host: string; website_host: string; dns_mode?: 'automatic' | 'external';
  site_prefix: string; share_background?: string;
  entries: Array<{ cdn_url: string; sha256: string; aliases: Array<{ url: string; key?: string }>; public_key?: string; mime_type?: string; share_source?: boolean }>;
}

/** What still stops a media host from serving a publication's files. */
export type MediaDeliveryIssue = 'domain_pending' | 'domain_inactive' | 'certificate_pending' | 'dns_missing' | 'not_served' | 'wrong_bytes' | 'unreachable';
export interface MediaDeliveryPending { host: string; issue: MediaDeliveryIssue; message: string; url?: string; http_status?: number }
export type MediaDeliveryResult =
  | { ready: true; scope: string; checked: number }
  | { ready: false; scope: string; checked: number; pending: MediaDeliveryPending };

/** Hosts Typeroll attaches to the public bucket for this manifest. */
function provisionedHosts(manifest: PublicMediaManifest, organizationHost: string | null | undefined) {
  return [...new Set([organizationHost, manifest.delivery === 'static' || manifest.media_host === manifest.website_host ? null : manifest.media_host]
    .filter((host): host is string => Boolean(host)))].sort();
}

/** Public URLs whose bytes prove delivery: every entry and retained alias outside the website deployment. */
function byteChecks(manifest: PublicMediaManifest) {
  return manifest.entries.flatMap(entry => [entry.cdn_url, ...entry.aliases.map(alias => alias.url)]
    .filter(url => new URL(url).hostname !== manifest.website_host && !(manifest.delivery === 'static' && new URL(url).hostname === manifest.media_host))
    .map(url => ({ url, hash: entry.sha256 })));
}

/**
 * Identity of a completed preparation: the hosts, namespace and files it
 * proved. A publication records it only after every check passed, so a
 * resumed or retried job cannot treat another manifest, or an earlier
 * unchecked flag, as proof that its media host serves its files.
 */
export function mediaDeliveryScope(manifest: PublicMediaManifest, organizationHost?: string | null) {
  return createHash('sha256').update(JSON.stringify({ account: manifest.account_id, bucket: manifest.public_bucket, site_prefix: manifest.site_prefix,
    hosts: provisionedHosts(manifest, organizationHost), checks: byteChecks(manifest).map(check => [check.url, check.hash]).sort(),
    share: manifest.entries.map(entry => shareCopyTarget(manifest, entry)?.url).filter(Boolean).sort() })).digest('hex');
}

function failureCode(error: unknown): string {
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (current.code === 'dns_failed' || ['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(current.code)) return 'dns';
    if (/CERT|TLS|SSL|EPROTO/i.test(String(current.code ?? '')) || /certificate|handshake|ssl|tls/i.test(String(current.message ?? ''))) return 'tls';
  }
  return 'other';
}

function pendingFor(manifest: PublicMediaManifest, url: string, result: { status?: number; error?: unknown; mismatch?: boolean }): MediaDeliveryPending {
  const host = new URL(url).hostname;
  const site = host === manifest.media_host && manifest.site_prefix ? ` The URL Rewrite Rule for ${host} must prepend /${manifest.site_prefix}, the site's namespace in ${manifest.public_bucket}.` : '';
  if (result.mismatch) return { host, url, issue: 'wrong_bytes', message: `${host} answers ${url} with different bytes than this publication stored.${site}` };
  if (result.status === 404) return { host, url, issue: 'not_served', http_status: 404, message: `${host} answers ${url} with HTTP 404: the file is missing at that address.${site} If the rule is correct, the upload did not finish; publish again.` };
  if (result.status) return { host, url, issue: 'unreachable', http_status: result.status, message: `${host} answers ${url} with HTTP ${result.status}.` };
  const code = failureCode(result.error);
  if (code === 'dns') return { host, url, issue: 'dns_missing', message: `${host} has no public DNS answer yet. Its R2 custom domain must exist in Cloudflare → R2 → ${manifest.public_bucket} → Settings → Custom Domains, which also creates its DNS record.` };
  if (code === 'tls') return { host, url, issue: 'certificate_pending', message: `${host} does not present a valid HTTPS certificate yet. Cloudflare issues it after the R2 custom domain is active; this usually takes a few minutes.` };
  return { host, url, issue: 'unreachable', message: `${host} did not answer ${url}.` };
}

async function fetchBytes(url: string, maxBytes: number): Promise<{ bytes?: Uint8Array; status?: number; error?: unknown }> {
  try {
    // The guarded fetch resolves, validates and connects in one step and caps the streamed body.
    const response = await safeFetch(parsePublicHttpsUrl(url), { redirect: 'error', headers: { 'Cache-Control': 'no-cache' } },
      { label: 'Media URL', timeoutMs: 10_000, maxBytes });
    if (!response.ok) return { status: response.status };
    if (Number(response.headers.get('content-length')) > maxBytes) return { status: 413 };
    return { bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch (error) { return { error }; }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Read-only proof that every public media host serves this manifest's exact
 * bytes: entries, retained aliases and stored share copies. The first failure
 * is returned with what remains to be done.
 */
export async function verifyPublicMediaDelivery(manifest: PublicMediaManifest, organizationHost?: string | null): Promise<MediaDeliveryResult> {
  const scope = mediaDeliveryScope(manifest, organizationHost);
  let checked = 0;
  for (const check of byteChecks(manifest)) {
    const result = await fetchBytes(check.url, MAX_MEDIA_CHECK_BYTES);
    if (!result.bytes || sha256(result.bytes) !== check.hash) return { ready: false, scope, checked, pending: pendingFor(manifest, check.url, { ...result, mismatch: Boolean(result.bytes) }) };
    checked++;
  }
  // A share copy exists when the build stored it; its public receipt names the bytes pages may reference.
  for (const entry of manifest.entries) {
    const target = shareCopyTarget(manifest, entry);
    if (!target) continue;
    const receipt = await fetchBytes(target.receipt_url, MAX_RECEIPT_BYTES);
    if (receipt.status === 404) continue;
    if (!receipt.bytes) return { ready: false, scope, checked, pending: pendingFor(manifest, target.receipt_url, receipt) };
    let expected: string | undefined;
    try { expected = JSON.parse(Buffer.from(receipt.bytes).toString()).sha256; } catch { expected = undefined; }
    const copy = await fetchBytes(target.url, MAX_MEDIA_CHECK_BYTES);
    if (!copy.bytes || !expected || sha256(copy.bytes) !== expected) return { ready: false, scope, checked, pending: pendingFor(manifest, target.url, { ...copy, mismatch: Boolean(copy.bytes) }) };
    checked++;
  }
  return { ready: true, scope, checked };
}

/**
 * Attach every public media host to the public R2 bucket, add the site's
 * namespace rule, and prove delivery. R2 remains static; one native path
 * rewrite maps a site host to its stable namespace. Each step reads before it
 * writes, so retrying after a partial failure finishes the remaining steps.
 */
export async function preparePublicMediaDelivery(orgId: string, manifest: PublicMediaManifest): Promise<MediaDeliveryResult> {
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.cloudflare?.account_id !== manifest.account_id || connection.cloudflare.public_bucket !== manifest.public_bucket) throw new ConnectionError('The media storage connection changed.', 409);
  const provider = await cloudflareClient(orgId, fetch, connection.revision);
  const organization = await getOrganizationDomains(orgId);
  const organizationHost = organization.media_host;
  const scope = mediaDeliveryScope(manifest, organizationHost);
  const root = `/accounts/${manifest.account_id}/r2/buckets/${manifest.public_bucket}/domains/custom`;
  for (const host of provisionedHosts(manifest, organizationHost)) {
    let current = await provider(`${root}/${host}`, { missing: true });
    const mode = host === organizationHost ? organization.dns_mode : manifest.dns_mode ?? organization.dns_mode;
    // External agents need no zone-read or ruleset grant in Typeroll. Actual public bytes below prove their setup.
    if (mode === 'external') {
      if (!current || current.enabled !== true) throw new ConnectionError(`Connect ${host} to the public R2 bucket ${manifest.public_bucket} in Cloudflare → R2 object storage → ${manifest.public_bucket} → Settings → Custom Domains. ${host !== organizationHost && manifest.site_prefix ? `For this site media host, add a URL Rewrite Rule that prepends /${manifest.site_prefix}. ` : ''}The domain must be added to the same Cloudflare account as the bucket. Keeping DNS at another provider requires Cloudflare Business/Enterprise partial setup. Then retry verification.`, 409, 'media_domain_setup_required');
    } else {
      const zone = await findPublishingZone(provider, manifest.account_id, host).catch(error => {
        if (error instanceof ConnectionError && error.code === 'domain_zone_required') throw new ConnectionError(`Add the domain for ${host} to the Cloudflare account connected to this organization. R2 custom domains require a zone in the same account. Move DNS to Cloudflare or, to retain another DNS provider, configure Cloudflare Business/Enterprise partial setup.`, 409, 'media_domain_zone_required');
        throw error;
      });
      if (!current) {
        const records = await provider(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`);
        if (records.some((record: { type: string }) => ['A', 'AAAA', 'CNAME', 'NS'].includes(record.type))) throw new ConnectionError('The media hostname already serves another destination. Prepare an explicit domain cutover before replacing it.', 409, 'media_domain_cutover_required');
        await provider(root, { method: 'POST', body: { domain: host, enabled: true, zoneId: zone.id, minTLS: '1.2' } });
        current = await provider(`${root}/${host}`);
      }
      if (current.enabled !== true || current.zoneId !== zone.id) throw new ConnectionError('Enable the selected R2 custom media domain in the connected account.', 409, 'media_domain_setup_required');
      if (host !== organizationHost) {
        const rulesRoot = `/zones/${zone.id}/rulesets`;
        const entrypoint = `${rulesRoot}/phases/http_request_transform/entrypoint`;
        let ruleset = await provider(entrypoint, { missing: true });
        const ref = `typeroll_media_${createHash('sha256').update(host).digest('hex').slice(0, 16)}`;
        const rule = { ref, action: 'rewrite', enabled: true, description: 'Typeroll site media path', expression: `http.host eq "${host}"`,
          action_parameters: { uri: { path: { expression: `concat("/${manifest.site_prefix}", http.request.uri.path)` } } } };
        const existing = ruleset?.rules?.find((candidate: { ref: string }) => candidate.ref === ref);
        if (existing && (existing.expression !== rule.expression || JSON.stringify(existing.action_parameters) !== JSON.stringify(rule.action_parameters) || existing.enabled === false)) throw new ConnectionError(`The media path rule for ${host} differs from the site's namespace /${manifest.site_prefix}. Review it in Cloudflare → Rules → Transform Rules before publishing.`, 409, 'media_path_rule_conflict');
        if (!existing) {
          if (!ruleset) {
            ruleset = await provider(rulesRoot, { method: 'POST', body: { name: 'Typeroll media paths', kind: 'zone', phase: 'http_request_transform', rules: [rule] } });
          } else await provider(`${rulesRoot}/${ruleset.id}/rules`, { method: 'POST', body: rule });
        }
      }
    }
    // Cloudflare reports ownership and certificate state; a domain is not served before both are active.
    const ownership = current?.status?.ownership, ssl = current?.status?.ssl;
    if (ownership && ownership !== 'active') return { ready: false, scope, checked: 0, pending: { host, issue: ['pending', 'initializing', 'unknown'].includes(ownership) ? 'domain_pending' : 'domain_inactive',
      message: `Cloudflare reports the R2 custom domain ${host} as ${ownership}, not active. ${['pending', 'initializing', 'unknown'].includes(ownership) ? 'It usually activates within a few minutes.' : `Check it in Cloudflare → R2 → ${manifest.public_bucket} → Settings → Custom Domains.`}` } };
    if (ssl && ssl !== 'active') return { ready: false, scope, checked: 0, pending: { host, issue: 'certificate_pending',
      message: `The HTTPS certificate for ${host} is ${ssl}, not active. Cloudflare issues it after the R2 custom domain is active; this usually takes a few minutes.` } };
  }
  // Verify real bytes on every retained public host, before making website traffic point at this publication.
  return verifyPublicMediaDelivery(manifest, organizationHost);
}

/** Attach media hosts and report only whether they serve their files. */
export async function preparePublicMediaDomains(orgId: string, manifest: PublicMediaManifest) {
  return (await preparePublicMediaDelivery(orgId, manifest)).ready;
}
