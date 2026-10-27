import { previousHostSummary } from './previous-hosts';
import { domainPublicationIntent } from './domain-publication-intent';
import { getConnection, ConnectionError } from './connections';
import { cloudflareClient } from './cloudflare-oauth';
import { siteHostingGroup } from './hosting-groups';
import { findZone, inactiveZoneMessage, type ZoneSummary } from './domain-provider';
import { classifyHostname } from '../domain-pair';
import type { DomainConfiguration, PublicationHosts } from './domain-config';

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;

export interface HostCheckItem {
  code: 'apex_zone_required' | 'apex_zone_in_other_account' | 'zone_not_active' | 'domain_zone_required' |
    'redirect_zone_required' | 'redirect_host_certificate_unavailable' | 'zone_check_unavailable' | 'redirect_outside_cloudflare';
  severity: 'blocking' | 'warning';
  host: string;
  message: string;
  zone?: { name: string; status: string; name_servers: string[] };
}

export interface HostCheck {
  host: string;
  role: 'website' | 'redirect';
  /** `apex` is the zone name itself; without a visible zone, a two-label name is treated as an apex. */
  kind: 'apex' | 'subdomain';
  zone: { name: string; status: string; account: 'hosting' | 'organization'; name_servers: string[] } | null;
  zone_check: 'found' | 'not_found' | 'unavailable';
}

export interface HostChecks {
  checked_at: string;
  hosts: HostCheck[];
  blockers: HostCheckItem[];
  warnings: HostCheckItem[];
}

export interface ZoneSource { account: 'hosting' | 'organization'; accountId: string; provider: Provider }

/** Universal SSL covers the zone apex and first-level subdomains only. */
export function coveredByUniversalSsl(host: string, zoneName: string) {
  return host === zoneName || (host.endsWith(`.${zoneName}`) && host.slice(0, -zoneName.length - 1).split('.').length === 1);
}

/**
 * Classify saved future hosts against the zones Typeroll can read, before any build or DNS step.
 * Pages accepts an apex custom domain only when it is an active zone in the Pages project's account.
 */
export async function checkPublicationHosts(hosts: PublicationHosts, dnsMode: DomainConfiguration['dns_mode'], sources: ZoneSource[]): Promise<HostChecks> {
  const result: HostChecks = { checked_at: new Date().toISOString(), hosts: [], blockers: [], warnings: [] };
  const add = (item: HostCheckItem) => (item.severity === 'blocking' ? result.blockers : result.warnings).push(item);
  const targets: Array<{ host: string; role: HostCheck['role'] }> = [
    ...(hosts.website_host ? [{ host: hosts.website_host, role: 'website' as const }] : []),
    ...(hosts.redirect_hosts ?? []).map(host => ({ host, role: 'redirect' as const })),
  ];
  for (const { host, role } of targets) {
    let found: { zone: ZoneSummary; source: ZoneSource } | null = null;
    let unavailable = sources.length === 0;
    // The hosting account first: an apex must be a zone where the Pages project lives.
    for (const source of sources) {
      try {
        const zone = await findZone(source.provider, source.accountId, host);
        if (zone) { found = { zone, source }; break; }
      } catch { unavailable = true; }
    }
    const zone = found ? { name: found.zone.name, status: found.zone.status, account: found.source.account, name_servers: found.zone.name_servers ?? [] } : null;
    const kind: HostCheck['kind'] = zone ? (zone.name === host ? 'apex' : 'subdomain') : classifyHostname(host).kind === 'apex' ? 'apex' : 'subdomain';
    result.hosts.push({ host, role, kind, zone, zone_check: zone ? 'found' : unavailable ? 'unavailable' : 'not_found' });
    const zoneDetail = zone ? { name: zone.name, status: zone.status, name_servers: zone.name_servers } : undefined;
    if (zone && zone.status !== 'active') {
      // A pending zone serves nothing. External DNS for a plain subdomain can still live elsewhere.
      const severity = role === 'website' && kind === 'subdomain' && dnsMode === 'external' ? 'warning' : 'blocking';
      add({ code: 'zone_not_active', severity, host, zone: zoneDetail, message: inactiveZoneMessage(zone) });
      continue;
    }
    if (role === 'website') {
      if (kind === 'apex' && zone && zone.account !== 'hosting') {
        add({ code: 'apex_zone_in_other_account', severity: 'blocking', host, zone: zoneDetail,
          message: `Cloudflare Pages accepts the apex ${host} only when ${zone.name} is a zone in the hosting account that serves the site. It is in the organization's DNS account instead. Move the zone to the Hosting Group's Cloudflare account, use a subdomain such as www.${host} as the website host, or select a Hosting Group connected to the account with the zone.` });
      } else if (kind === 'apex' && !zone && !unavailable) {
        add({ code: 'apex_zone_required', severity: 'blocking', host,
          message: `Cloudflare Pages serves an apex hostname such as ${host} only when the domain is an active zone in the hosting account's Cloudflare account, with Cloudflare nameservers. External DNS cannot point an apex at Pages. Add ${host} to that Cloudflare account and change its nameservers, or use a subdomain such as www.${host} as the website host and redirect the apex at your DNS provider.` });
      } else if (kind === 'apex' && !zone) {
        add({ code: 'zone_check_unavailable', severity: 'warning', host,
          message: `Typeroll could not read zones in the connected Cloudflare accounts. An apex such as ${host} works only when the domain is an active zone in the hosting account; confirm this before preparing.` });
      } else if (!zone && dnsMode === 'automatic' && !unavailable) {
        add({ code: 'domain_zone_required', severity: 'blocking', host,
          message: `${host} is not in a zone in the connected Cloudflare accounts, so Typeroll cannot manage its DNS. Add the domain in Cloudflare or select external DNS management and apply the returned records yourself.` });
      }
      continue;
    }
    if (zone && !coveredByUniversalSsl(host, zone.name)) {
      add({ code: 'redirect_host_certificate_unavailable', severity: dnsMode === 'automatic' ? 'blocking' : 'warning', host, zone: zoneDetail,
        message: `${host} is more than one level below ${zone.name}. Cloudflare's Universal SSL certificate covers only ${zone.name} and its first-level subdomains, so a redirect on this host needs an advanced certificate. Use a first-level name such as www.${zone.name}.` });
    } else if (!zone && !unavailable) {
      add(dnsMode === 'automatic'
        ? { code: 'redirect_zone_required', severity: 'blocking', host, message: `${host} must be in an active Cloudflare zone in a connected account so its redirect can run at Cloudflare's edge. Add the domain in Cloudflare, or select external DNS management and serve the 301 redirect at your DNS provider; Typeroll verifies it after the switch.` }
        : { code: 'redirect_outside_cloudflare', severity: 'warning', host, message: `${host} is not in a connected Cloudflare zone. Serve a permanent redirect (301) to https://${hosts.website_host} that keeps the path and query at your DNS or hosting provider. Typeroll verifies it after the traffic switch.` });
    } else if (!zone) {
      add({ code: 'zone_check_unavailable', severity: 'warning', host, message: `Typeroll could not read zones in the connected Cloudflare accounts to confirm that ${host} is in an active zone.` });
    }
  }
  return result;
}

const cache = new Map<string, { expires: number; value: HostChecks }>();

/** Connected Cloudflare accounts that can show this site's zones, hosting account first. */
export async function siteZoneSources(orgId: string, siteId: string): Promise<ZoneSource[]> {
  const group = await siteHostingGroup(orgId, siteId);
  const sources: ZoneSource[] = [];
  for (const id of [...new Set([group.id, 'default'])]) {
    const connection = await getConnection(orgId, 'cloudflare', id);
    if (connection.status !== 'connected' || !connection.cloudflare) continue;
    if (sources.some(source => source.accountId === connection.cloudflare!.account_id)) continue;
    try {
      sources.push({ account: id === group.id ? 'hosting' : 'organization', accountId: connection.cloudflare.account_id,
        provider: await cloudflareClient(orgId, fetch, undefined, id) });
    } catch { /* An expired grant must not hide the saved settings; checks report "unavailable". */ }
  }
  return sources;
}

/** Host checks for the saved future hosts, briefly cached because settings pages poll. */
export async function siteHostChecks(orgId: string, siteId: string, config: DomainConfiguration): Promise<HostChecks | null> {
  if (!config.desired.website_host) return null;
  const key = `${orgId}\0${siteId}\0${config.revision}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await checkPublicationHosts(config.desired, config.dns_mode, await siteZoneSources(orgId, siteId));
  cache.set(key, { expires: Date.now() + 60_000, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

/** The saved domain settings with structured host checks, as returned by the UI, API and MCP. */
export async function siteDomainsWithChecks(orgId: string, siteId: string, config: DomainConfiguration, versionId = 'main') {
  let host_checks: HostChecks | null = null;
  try { host_checks = await siteHostChecks(orgId, siteId, config); }
  catch (error) {
    // Reading settings must keep working when Cloudflare is unreachable or a grant expired.
    console.warn(JSON.stringify({ event: 'publishing_host_checks_unavailable', org_id: orgId, site_id: siteId, code: error instanceof ConnectionError ? error.code : 'provider_unavailable' }));
  }
  return { ...config, previous_hosts: previousHostSummary(config), host_checks, next_publication: versionId === 'main' ? domainPublicationIntent(config) : null };
}

/** Stop before building a candidate that Cloudflare cannot serve. */
export function assertHostChecks(checks: HostChecks | null) {
  const first = checks?.blockers[0];
  if (first) throw new ConnectionError(checks!.blockers.map(item => item.message).join(' '), 409, first.code, { blockers: checks!.blockers });
}
