import { createHash } from 'node:crypto';
import { ConnectionError } from './connections';
import { ProviderError } from './providers.mjs';
import { hostingDns } from './hosting-dns';
import { findZone, trafficFingerprint } from './domain-provider';
import { assertTrafficNotOwnedByOtherOrganization } from './cloudflare-account-claims';
import { redirectRuleSpec, readRedirectRule, ensureRedirectRule, verifyRedirectHost, type RedirectPreparation } from './redirect-hosts';
import { journaledDomainProvider, recordDomainCutover } from './domain-cutover-journal';
import { publicationHostname, type DomainConfiguration } from './domain-config';
import { createSafeFetch } from '../net/safe-fetch';

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
export type PreviousHost = { host: string; target_host: string; mode: 'redirect' | 'noindex'; status: 'pending' | 'verified' | 'warning'; message: string; checked_at?: string };
export type PreviousHostPreparation = { host: string; target_host: string; redirect: RedirectPreparation | null; message: string };
const fetchPrevious = createSafeFetch({ label: 'Previous website address', maxRedirects: 0, timeoutMs: 10_000, maxBytes: 64 * 1024 });

/** Only recorded website origins, never arbitrary media hosts or provider deployment URLs. */
export function previousWebsiteHosts(config: DomainConfiguration, target: string, priorHost?: string): string[] {
  return [...new Set([priorHost, config.active?.website_host, ...config.media_aliases.map(alias => alias.website_host), ...(config.previous_hosts ?? []).map(item => item.host)])]
    .filter((host): host is string => !!host && host !== target && !host.endsWith('.pages.dev'))
    .map(host => publicationHostname(host)).sort();
}

/** Read-only preparation. Existing Pages certificates cover deep temporary subdomains too. */
export async function preparePreviousHosts(org: string, group: string, hosts: string[], target: string, pages: Provider, account: string, project: string): Promise<PreviousHostPreparation[]> {
  const result: PreviousHostPreparation[] = [];
  for (const host of hosts) {
    const fallback = (message: string) => result.push({ host, target_host: target, redirect: null, message });
    try {
      const domain = await pages(`/accounts/${account}/pages/projects/${project}/domains/${encodeURIComponent(host)}`, { missing: true });
      if (domain?.status !== 'active') { fallback('The previous address has no active Pages certificate. Its publication must serve a verified noindex header.'); continue; }
      const access = await hostingDns(org, group, host);
      const zone = await findZone(access.provider, access.accountId, host);
      if (!zone || zone.status !== 'active') { fallback('Connect DNS access to the previous address to enable its automatic redirect.'); continue; }
      const records = (await access.provider(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
      await assertTrafficNotOwnedByOtherOrganization(org, access.accountId, records);
      if (!records.length || records.some((record: any) => !record.proxied || record.type !== 'CNAME' || String(record.content).toLowerCase().replace(/\.$/, '') !== `${project}.pages.dev`)) { fallback('The previous address must keep its existing proxied Pages DNS record for the redirect.'); continue; }
      // Separate ownership from optional www aliases; these rules belong to retirement and rollback.
      const rule = { ...redirectRuleSpec(host, target, zone.name), ref: `typeroll_previous_${createHash('sha256').update(host).digest('hex').slice(0, 16)}` };
      const current = await readRedirectRule(access.provider, zone.id, rule);
      if (current.status === 'unverifiable' || current.status === 'conflict') { fallback('The previous address is protected by noindex until its Single Redirect permission or conflicting rule is resolved.'); continue; }
      result.push({ host, target_host: target, message: '', redirect: {
        hostname: host, target_host: target, zone_id: zone.id, zone_name: zone.name,
        provider_status: 'redirect', certificate_ready: true, edge_certificate: 'active', requirements: [],
        has_existing_traffic: true, previous_records: records, dns_fingerprint: trafficFingerprint(records),
        action: 'approve_cutover', validation_blocker: null, rule: { ...rule, status: current.status },
      } });
    } catch (error) {
      if (error instanceof ProviderError && [401, 403].includes(error.status) || error instanceof ConnectionError && error.code === 'domain_zone_required') {
        fallback('The connected account cannot manage the previous address. A verified noindex header protects it; enable Single Redirect access to finish.');
      } else throw error;
    }
  }
  return result;
}

/** Never report retirement as safe based on configuration alone. Inspect the public response. */
export async function checkPreviousHost(host: string, target: string, publication: string, fetchImpl: typeof fetch = fetchPrevious): Promise<PreviousHost> {
  const redirect = await verifyRedirectHost(host, target, publication, fetchImpl);
  if (redirect.ok) return { host, target_host: target, mode: 'redirect', status: 'verified', message: '301 redirect preserves the path and query string.', checked_at: new Date().toISOString() };
  const response = await fetchImpl(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const robots = response.headers.get('x-robots-tag') ?? '';
  if (response.status === 200 && /\bnoindex\b/i.test(robots) && /\bnofollow\b/i.test(robots) && response.headers.get('x-typeroll-publication') === publication) {
    return { host, target_host: target, mode: 'noindex', status: 'warning', message: 'The old address is blocked from indexing. Its 301 redirect still needs attention to DNS, Single Redirect configuration or permissions.', checked_at: new Date().toISOString() };
  }
  throw new ConnectionError(`The previous address ${host} is neither redirected to ${target} nor protected by the current publication's noindex header. Check its DNS, redirect rules and cache.`, 409, 'previous_host_unprotected');
}

/** Apply only approved, journaled rules; never replace the old DNS or detach media-serving domains. */
export async function retirePreviousHosts(org: string, site: string, group: string, publication: string, hosts: string[], target: string,
  approved: PreviousHostPreparation[] = [], apply = false, fetchImpl?: typeof fetch): Promise<PreviousHost[]> {
  const result: PreviousHost[] = [];
  for (const host of hosts) {
    const preparation = approved.find(item => item.host === host && item.target_host === target)?.redirect;
    if (apply && preparation?.zone_id) {
      const access = await hostingDns(org, group, host);
      const records = (await access.provider(`/zones/${preparation.zone_id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
      if (trafficFingerprint(records) !== preparation.dns_fingerprint) throw new ConnectionError('The previous address DNS changed after approval. Review it before enabling its redirect.', 409, 'dns_revision_conflict');
      try { await ensureRedirectRule(journaledDomainProvider(access.provider, org, site, publication, host), preparation.zone_id, preparation.rule, host, target); }
      catch (error) {
        // A deterministic provider refusal leaves the artifact's verified noindex fallback.
        // Transport errors and uncertain writes must resume through the existing job retry.
        if (!(error instanceof ProviderError) || ![400, 401, 403].includes(error.status)) throw error;
      }
      await recordDomainCutover(org, site, publication, host);
    }
    result.push(await checkPreviousHost(host, target, publication, fetchImpl));
  }
  return result;
}

/** Reads expose unprotected legacy aliases too; a saved alias is not evidence of protection. */
export function previousHostSummary(config: DomainConfiguration): PreviousHost[] {
  const target = config.published?.hosts.website_host ?? config.active?.website_host;
  if (!target) return [];
  return previousWebsiteHosts(config, target).map(host => config.previous_hosts?.find(item => item.host === host && item.target_host === target) ?? {
    host, target_host: target, mode: 'noindex', status: 'pending',
    message: 'Protection has not been verified. Publish with the updated build engine, then approve the domain switch to enable its redirect.',
  });
}
