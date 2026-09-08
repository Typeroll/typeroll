import { digest } from './providers.mjs';
import { ConnectionError } from './connections';
import { publicationHostname } from './domain-config';

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
export interface DnsRequirement {
  phase: 'validation' | 'traffic'; type: 'TXT' | 'CNAME'; name: string; content: string;
  proxied?: boolean; status: 'required' | 'configured';
}
export interface DomainPreparation {
  hostname: string; provider_status: string; certificate_ready: boolean;
  requirements: DnsRequirement[]; dns_fingerprint: string | null;
  action: 'verify' | 'configure_dns' | 'approve_cutover' | 'complete_validation';
  has_existing_traffic?: boolean;
  zone_id?: string;
  previous_records?: Array<{ id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }>;
}

export function trafficFingerprint(records: Array<{ id: string; type: string; content: string; proxied?: boolean }>) {
  return digest(JSON.stringify(records.map(({ id, type, content, proxied }) => ({ id, type, content, proxied })).sort((a, b) => a.id.localeCompare(b.id))));
}

/** Resolve actual zone boundaries in the selected account, including multi-label public suffixes. */
export async function findPublishingZone(provider: Provider, accountId: string, hostname: string) {
  const parts = publicationHostname(hostname).split('.');
  for (let offset = 0; offset < parts.length - 1; offset++) {
    const name = parts.slice(offset).join('.');
    const zones = await provider(`/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(name)}&per_page=50`);
    const zone = zones.find((zone: any) => zone.name === name && zone.account?.id === accountId && zone.status === 'active');
    if (zone) return zone;
  }
  throw new ConnectionError('This hostname is not in an active zone in the organization’s connected Cloudflare account. Add the domain to that account or use external DNS management.', 409, 'domain_zone_required');
}

function trafficRequirement(hostname: string, project: string, branch: string): DnsRequirement {
  return { phase: 'traffic', type: 'CNAME', name: hostname,
    content: `${branch === 'main' ? '' : `${branch}.`}${project}.pages.dev`, proxied: true, status: 'required' };
}

/** Register the hostname after a verified build, without overwriting existing customer traffic. */
export async function preparePagesDomain(provider: Provider, input: { accountId: string; project: string; branch: string; hostname: string; dnsMode: 'automatic' | 'external'; configureTraffic?: boolean; dnsProvider?: Provider; dnsAccountId?: string }): Promise<DomainPreparation> {
  const hostname = publicationHostname(input.hostname);
  if (!/^[a-z0-9-]{1,58}$/.test(input.project) || !/^(main|version-[a-z0-9-]+)$/.test(input.branch)) throw new ConnectionError('Invalid publishing target');
  const root = `/accounts/${input.accountId}/pages/projects/${input.project}/domains`;
  let domain = await provider(`${root}/${hostname}`, { missing: true });
  if (!domain) {
    await provider(root, { method: 'POST', body: { name: hostname } });
    domain = await provider(`${root}/${hostname}`);
  }
  const traffic = trafficRequirement(hostname, input.project, input.branch);
  const requirements: DnsRequirement[] = [];
  const validation = domain.validation_data;
  if (validation?.method === 'txt' && typeof validation.txt_name === 'string' && typeof validation.txt_value === 'string') {
    requirements.push({ phase: 'validation', type: 'TXT', name: validation.txt_name, content: validation.txt_value,
      status: validation.status === 'active' ? 'configured' : 'required' });
  }
  requirements.push(traffic);
  const result: DomainPreparation = { hostname, provider_status: String(domain.status ?? 'pending'),
    certificate_ready: domain.status === 'active', requirements, dns_fingerprint: null, action: 'configure_dns' };
  if (input.dnsMode === 'external') {
    result.action = result.certificate_ready ? 'approve_cutover' : 'complete_validation';
    return result;
  }
  const dns = input.dnsProvider ?? provider;
  const zone = await findPublishingZone(dns, input.dnsAccountId ?? input.accountId, hostname);
  const records = await dns(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`);
  const addressRecords = records.filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  result.has_existing_traffic = addressRecords.length > 0;
  result.zone_id = zone.id;
  result.previous_records = addressRecords.map(({ id, type, name, content, proxied, ttl }: any) => ({ id, type, name, content, proxied, ttl }));
  result.dns_fingerprint = trafficFingerprint(addressRecords);
  if (addressRecords.length === 1 && addressRecords[0].type === 'CNAME' && addressRecords[0].content === traffic.content && addressRecords[0].proxied === true) {
    traffic.status = 'configured'; result.action = 'verify'; return result;
  }
  if (addressRecords.length) {
    result.action = result.certificate_ready ? 'approve_cutover' : 'complete_validation';
    return result;
  }
  if (input.configureTraffic === false) return result;
  // A brand new hostname has no old website to interrupt. Never delete or replace records here.
  await dns(`/zones/${zone.id}/dns_records`, { method: 'POST', body: {
    type: traffic.type, name: traffic.name, content: traffic.content, proxied: true, ttl: 1,
    comment: 'Typeroll static publication',
  } });
  traffic.status = 'configured'; result.action = 'verify';
  return result;
}

/** Apply only the reviewed traffic change; concurrent DNS edits invalidate approval. */
export async function applyPreparedTraffic(provider: Provider, approved: DomainPreparation): Promise<void> {
  if (!approved.zone_id || !approved.dns_fingerprint) throw new ConnectionError('Apply the reviewed DNS records with your DNS administrator or AI agent, then verify again.', 409, 'external_dns_required');
  const requirement = approved.requirements.find(record => record.phase === 'traffic');
  if (!requirement || requirement.name !== approved.hostname) throw new ConnectionError('Prepare domain verification again.', 409);
  const root = `/zones/${approved.zone_id}/dns_records`;
  const records = (await provider(`${root}?name=${encodeURIComponent(approved.hostname)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (records.length === 1 && records[0].type === 'CNAME' && records[0].content === requirement.content && records[0].proxied === true) return;
  if (trafficFingerprint(records) !== approved.dns_fingerprint) throw new ConnectionError('DNS changed after the traffic switch was reviewed. Verify the domain and approve the new records before retrying.', 409, 'dns_revision_conflict');
  if (records.length && !approved.certificate_ready) throw new ConnectionError('Cloudflare has not confirmed a working certificate. Keep current traffic in place and complete domain validation first.', 409, 'domain_certificate_pending');
  if (records.length > 1) throw new ConnectionError('This hostname has multiple address records. Your DNS administrator or AI agent must apply the reviewed change; Typeroll will not delete them automatically.', 409, 'external_dns_required');
  const body = { type: 'CNAME', name: approved.hostname, content: requirement.content, proxied: true, ttl: 1, comment: 'Typeroll static publication' };
  await provider(records.length ? `${root}/${records[0].id}` : root, { method: records.length ? 'PATCH' : 'POST', body });
}
