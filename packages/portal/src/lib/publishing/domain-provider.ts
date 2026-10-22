import { digest } from './providers.mjs';
import { ConnectionError } from './connections';
import { publicationHostname } from './domain-config';
import { assertTrafficNotOwnedByOtherOrganization } from './cloudflare-account-claims';

type Provider = (route: string, options?: { method?: string; body?: unknown; missing?: boolean }) => Promise<any>;
export interface DnsRequirement {
  phase: 'validation' | 'traffic'; type: 'TXT' | 'CNAME' | 'A'; name: string; content: string;
  proxied?: boolean; status: 'required' | 'configured';
}
export interface DomainPreparation {
  hostname: string; provider_status: string; certificate_ready: boolean;
  requirements: DnsRequirement[]; dns_fingerprint: string | null;
  action: 'verify' | 'configure_dns' | 'approve_cutover' | 'complete_validation';
  has_existing_traffic?: boolean;
  /** `resolution` says how to proceed: accept the validation window on approval, or apply a multi-record change externally. */
  validation_blocker?: { code: 'domain_prevalidation_unavailable'; message: string; resolution?: 'accept_validation_window' | 'external_dns_change' } | null;
  zone_id?: string;
  previous_records?: Array<{ id: string; type: string; name: string; content: string; proxied?: boolean; ttl?: number }>;
}

export function trafficFingerprint(records: Array<{ id: string; type: string; content: string; proxied?: boolean }>) {
  return digest(JSON.stringify(records.map(({ id, type, content, proxied }) => ({ id, type, content, proxied })).sort((a, b) => a.id.localeCompare(b.id))));
}

export interface ZoneSummary { id: string; name: string; status: string; name_servers?: string[]; activated_on?: string }

function zoneSummary(zone: any): ZoneSummary {
  return { id: String(zone.id), name: String(zone.name), status: String(zone.status ?? 'unknown'),
    ...(Array.isArray(zone.name_servers) ? { name_servers: zone.name_servers.filter((server: unknown) => typeof server === 'string') } : {}),
    ...(typeof zone.activated_on === 'string' ? { activated_on: zone.activated_on } : {}) };
}

/** The closest zone for a hostname in one account, whatever its status. */
export async function findZone(provider: Provider, accountId: string, hostname: string): Promise<ZoneSummary | null> {
  const parts = publicationHostname(hostname).split('.');
  for (let offset = 0; offset < parts.length - 1; offset++) {
    const name = parts.slice(offset).join('.');
    const zones = await provider(`/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(name)}&per_page=50`);
    const zone = zones.find((zone: any) => zone.name === name && zone.account?.id === accountId);
    if (zone) return zoneSummary(zone);
  }
  return null;
}

/** What a zone that is not active means, in Cloudflare's terms (pending = nameservers not seen yet). */
export function inactiveZoneMessage(zone: Pick<ZoneSummary, 'name' | 'status' | 'name_servers'>) {
  return `${zone.name} is in the Cloudflare account, but its status is ${zone.status}, not active. Cloudflare does not proxy records or issue certificates for a zone until it sees the assigned nameservers at the registrar${zone.name_servers?.length ? ` (${zone.name_servers.join(', ')})` : ''}. Change the nameservers at the registrar, keep the existing records DNS only, and wait until Cloudflare marks the zone active.`;
}

/** Resolve actual zone boundaries in the selected account, including multi-label public suffixes. */
export async function findPublishingZone(provider: Provider, accountId: string, hostname: string) {
  const parts = publicationHostname(hostname).split('.');
  let inactive: ZoneSummary | null = null;
  for (let offset = 0; offset < parts.length - 1; offset++) {
    const name = parts.slice(offset).join('.');
    const zones = await provider(`/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(name)}&per_page=50`);
    const zone = zones.find((zone: any) => zone.name === name && zone.account?.id === accountId && zone.status === 'active');
    if (zone) return zone;
    const other = zones.find((zone: any) => zone.name === name && zone.account?.id === accountId);
    if (other && !inactive) inactive = zoneSummary(other);
  }
  if (inactive) throw new ConnectionError(inactiveZoneMessage(inactive), 409, 'domain_zone_required', { zone: { name: inactive.name, status: inactive.status, name_servers: inactive.name_servers ?? [] } });
  throw new ConnectionError('This hostname is not in an active zone in the organization’s connected Cloudflare account. Add the domain to that account or use external DNS management.', 409, 'domain_zone_required');
}

const describeRecord = (record: { type: string; name: string; content: string; proxied?: boolean }) => `${record.type} ${record.name} ${record.content} (${record.proxied ? 'proxied' : 'DNS only'})`;

/**
 * Cloudflare Pages validates this hostname over HTTP only once its record points at Pages, and offers no
 * pre-validation. The switch therefore has a window until Cloudflare validates it; Cloudflare does not
 * document its length. A single reviewed record can be switched by Typeroll after explicit acceptance.
 */
function prevalidationBlocker(hostname: string, traffic: DnsRequirement, previous: NonNullable<DomainPreparation['previous_records']>): NonNullable<DomainPreparation['validation_blocker']> {
  const restore = previous.map(describeRecord).join(', ');
  const switchStep = previous.length === 1
    ? 'At a quiet time, approve the switch and accept the validation window (Switch website traffic in Publishing, or approve_publishing_domain_cutover with accept_validation_window: true). Typeroll then changes this one reviewed record, waits for Cloudflare to validate the hostname and verifies the published site before marking it live.'
    : `At a quiet time, replace the ${previous.length} current records with the proxied ${traffic.type} ${traffic.name} → ${traffic.content} yourself or through your AI agent, then prepare the domain change again. Typeroll does not delete several records automatically.`;
  return { code: 'domain_prevalidation_unavailable', resolution: previous.length === 1 ? 'accept_validation_window' : 'external_dns_change',
    message: `Cloudflare Pages validates ${hostname} only after its record points at Pages (Cloudflare reports "CNAME record not set"), and it cannot validate the hostname while the current website keeps serving it. Expect a short window after the switch in which ${hostname} does not answer until Cloudflare finishes validation; Cloudflare does not document how long this takes. Before switching, keep the zone active with DNS-only records and wait until its Universal SSL certificate is active (SSL/TLS → Edge Certificates; Cloudflare issues it 15 minutes to 24 hours after the zone becomes active). ${switchStep} To roll back, restore ${restore}. Retrying the build or reconnecting the account does not change this requirement.` };
}

function trafficRequirement(hostname: string, project: string, branch: string): DnsRequirement {
  return { phase: 'traffic', type: 'CNAME', name: hostname,
    content: `${branch === 'main' ? '' : `${branch}.`}${project}.pages.dev`, proxied: true, status: 'required' };
}

/** Register the hostname after a verified build, without overwriting existing customer traffic. */
/** `orgId` is the Organization publishing: a hostname that serves another Organization's Pages project in the same account is never prepared for replacement. */
export async function preparePagesDomain(provider: Provider, input: { accountId: string; project: string; branch: string; hostname: string; dnsMode: 'automatic' | 'external'; configureTraffic?: boolean; dnsProvider?: Provider; dnsAccountId?: string; orgId?: string }): Promise<DomainPreparation> {
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
    certificate_ready: domain.status === 'active', validation_blocker: null, requirements, dns_fingerprint: null, action: 'configure_dns' };
  if (input.dnsMode === 'external') {
    result.action = result.certificate_ready ? 'approve_cutover' : 'complete_validation';
    return result;
  }
  const dns = input.dnsProvider ?? provider;
  const zone = await findPublishingZone(dns, input.dnsAccountId ?? input.accountId, hostname);
  const records = await dns(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`);
  const addressRecords = records.filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (input.orgId) await assertTrafficNotOwnedByOtherOrganization(input.orgId, input.accountId, addressRecords);
  result.has_existing_traffic = addressRecords.length > 0;
  result.zone_id = zone.id;
  result.previous_records = addressRecords.map(({ id, type, name, content, proxied, ttl }: any) => ({ id, type, name, content, proxied, ttl }));
  result.dns_fingerprint = trafficFingerprint(addressRecords);
  if (addressRecords.length === 1 && addressRecords[0].type === 'CNAME' && addressRecords[0].content === traffic.content && addressRecords[0].proxied === true) {
    traffic.status = 'configured'; result.action = 'verify'; return result;
  }
  if (addressRecords.length) {
    if (!result.certificate_ready && validation?.method === 'http' && domain.verification_data?.error_message === 'CNAME record not set') {
      result.validation_blocker = prevalidationBlocker(hostname, traffic, result.previous_records!);
    }
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

/** Whether an approval may switch this reviewed record before Cloudflare can validate the hostname. */
export function validationWindowAllowed(preparation: DomainPreparation | null | undefined) {
  return preparation?.validation_blocker?.code === 'domain_prevalidation_unavailable' && Boolean(preparation.zone_id) && preparation.previous_records?.length === 1;
}

/** Apply only the reviewed traffic change; concurrent DNS edits invalidate approval. */
export async function applyPreparedTraffic(provider: Provider, approved: DomainPreparation, options: { acceptValidationWindow?: boolean } = {}): Promise<void> {
  if (!approved.zone_id || !approved.dns_fingerprint) throw new ConnectionError('Apply the reviewed DNS records with your DNS administrator or AI agent, then verify again.', 409, 'external_dns_required');
  const requirement = approved.requirements.find(record => record.phase === 'traffic');
  if (!requirement || requirement.name !== approved.hostname) throw new ConnectionError('Prepare domain verification again.', 409);
  const root = `/zones/${approved.zone_id}/dns_records`;
  const records = (await provider(`${root}?name=${encodeURIComponent(approved.hostname)}&per_page=100`)).filter((record: any) => ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (records.length === 1 && records[0].type === requirement.type && records[0].content === requirement.content && records[0].proxied === true) return;
  if (trafficFingerprint(records) !== approved.dns_fingerprint) throw new ConnectionError('DNS changed after the traffic switch was reviewed. Verify the domain and approve the new records before retrying.', 409, 'dns_revision_conflict');
  // The accepted window is the only case where a record changes before Cloudflare confirms a certificate.
  if (records.length && !approved.certificate_ready && !(options.acceptValidationWindow && validationWindowAllowed(approved))) throw new ConnectionError('Cloudflare has not confirmed a working certificate. Keep current traffic in place and complete domain validation first.', 409, 'domain_certificate_pending');
  if (records.length > 1) throw new ConnectionError('This hostname has multiple address records. Your DNS administrator or AI agent must apply the reviewed change; Typeroll will not delete them automatically.', 409, 'external_dns_required');
  const body = { type: requirement.type, name: approved.hostname, content: requirement.content, proxied: true, ttl: 1, comment: 'Typeroll static publication' };
  await provider(records.length ? `${root}/${records[0].id}` : root, { method: records.length ? 'PATCH' : 'POST', body });
}
