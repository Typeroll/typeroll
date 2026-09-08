import { createHash } from 'node:crypto';
import { getConnection, ConnectionError } from './connections';
import { cloudflareClient } from './cloudflare-oauth';
import { findPublishingZone } from './domain-provider';
import { getOrganizationDomains } from './domain-config';
import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';

/** R2 remains static; one native path rewrite maps a site host to its stable namespace. */
export async function preparePublicMediaDomains(orgId: string, manifest: { account_id: string; public_bucket: string; media_host: string; website_host: string; dns_mode?: 'automatic' | 'external'; site_prefix: string; entries: Array<{ cdn_url: string; sha256: string; aliases: Array<{ url: string }> }> }) {
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.cloudflare?.account_id !== manifest.account_id || connection.cloudflare.public_bucket !== manifest.public_bucket) throw new ConnectionError('The media storage connection changed.', 409);
  const provider = await cloudflareClient(orgId);
  const organization = await getOrganizationDomains(orgId);
  const organizationHost = organization.default_domain;
  const hosts = new Set([organizationHost, manifest.media_host === manifest.website_host ? null : manifest.media_host].filter((host): host is string => Boolean(host)));
  const root = `/accounts/${manifest.account_id}/r2/buckets/${manifest.public_bucket}/domains/custom`;
  for (const host of hosts) {
    let current = await provider(`${root}/${host}`, { missing: true });
    const mode = host === organizationHost ? organization.dns_mode : manifest.dns_mode ?? organization.dns_mode;
    // External agents need no zone-read or ruleset grant in Typeroll. Actual public bytes below prove their setup.
    if (mode === 'external') {
      if (!current || current.enabled !== true) throw new ConnectionError(`Connect ${host} to the public R2 bucket ${manifest.public_bucket} in Cloudflare → R2 object storage → ${manifest.public_bucket} → Settings → Custom Domains. For a site media host, add a URL Rewrite Rule that prepends /${manifest.site_prefix}. The domain must be added to the same Cloudflare account as the bucket. Keeping DNS at another provider requires Cloudflare Business/Enterprise partial setup. Then retry verification.`, 409, 'media_domain_setup_required');
      continue;
    }
    const zone = await findPublishingZone(provider, manifest.account_id, host).catch(error => {
      if (error instanceof ConnectionError && error.code === 'domain_zone_required') throw new ConnectionError(`Add the domain for ${host} to the Cloudflare account connected to this organization. R2 custom domains require a zone in the same account. Move DNS to Cloudflare or, to retain another DNS provider, configure Cloudflare Business/Enterprise partial setup.`, 409, 'media_domain_zone_required');
      throw error;
    });
    if (!current) {
      const records = await provider(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`);
      if (records.some((record: { type: string }) => ['A', 'AAAA', 'CNAME'].includes(record.type))) throw new ConnectionError('The media hostname already serves another destination. Prepare an explicit domain cutover before replacing it.', 409, 'media_domain_cutover_required');
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
      if (existing && (existing.expression !== rule.expression || JSON.stringify(existing.action_parameters) !== JSON.stringify(rule.action_parameters) || existing.enabled === false)) throw new ConnectionError('The media path rule differs from the saved site namespace. Review it before publishing.', 409, 'media_path_rule_conflict');
      if (!existing) {
        if (!ruleset) {
          ruleset = await provider(rulesRoot, { method: 'POST', body: { name: 'Typeroll media paths', kind: 'zone', phase: 'http_request_transform', rules: [rule] } });
        } else await provider(`${rulesRoot}/${ruleset.id}/rules`, { method: 'POST', body: rule });
      }
    }
  }
  // Verify real bytes on every retained public host, before making website traffic point at this publication.
  const checks = manifest.entries.flatMap(entry => [entry.cdn_url, ...entry.aliases.map(alias => alias.url)]
    .filter(url => new URL(url).hostname !== manifest.website_host).map(url => ({ url, hash: entry.sha256 })));
  for (const check of checks) {
    try {
      const url = parsePublicHttpsUrl(check.url); await assertPublicDestination(url);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok || Number(response.headers.get('content-length')) > 25 * 1024 * 1024) return false;
      const actual = createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
      if (actual !== check.hash) return false;
    } catch { return false; }
  }
  return true;
}
