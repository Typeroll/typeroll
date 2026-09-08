import { ConnectionError, connectionSummary, getConnection, openCredentials } from './connections';
import { cloudflareClient } from './cloudflare-oauth';
import { getOrganizationDomains, publicationHostname, saveOrganizationDomains } from './domain-config';
import { getOrganizationDomainStatus } from './organization-domain-status';
import { preparePublicMediaDomains } from './media-domain';
import { requestMediaMigration } from './media-migration';
import { ProviderError } from './providers.mjs';

export interface PublishingZone { id: string; name: string; status: string; type: string }

async function connectedAccount(orgId: string) {
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.status !== 'connected' || !connection.cloudflare) throw new ConnectionError('Connect Cloudflare in Publishing first.', 409, 'cloudflare_required');
  return { connection, cf: connection.cloudflare, provider: await cloudflareClient(orgId, fetch, connection.revision) };
}

function domainAccessError(error: unknown): never {
  if ((error instanceof ConnectionError || error instanceof ProviderError) && [401, 403].includes(error.status)) throw new ConnectionError('Cloudflare denied domain access. Allow domain access in Publishing to approve domain and DNS permissions. Your connected account and R2 settings are retained.', 403, 'domain_access_required');
  throw error;
}

/** Only expose domains from the organization's connected account, never other accounts on the token. */
export async function listOrganizationPublishingZones(orgId: string) {
  const { cf, connection, provider } = await connectedAccount(orgId);
  const credentials = connection.auth_method === 'oauth' && connection.encrypted_credentials
    ? openCredentials<{ oauth?: { scope: string } }>(orgId, 'cloudflare', connection.encrypted_credentials) : null;
  const scopes = credentials?.oauth?.scope.split(/\s+/);
  const domain_access = !scopes ? 'unknown' : ['zone.read', 'dns.read', 'dns.write'].every(scope => scopes.includes(scope)) ? 'granted' : 'approval_required';
  if (scopes && !scopes.includes('zone.read')) return { account_name: cf.account_name, zones: [], domain_access };
  const zones: PublishingZone[] = [];
  try {
    for (let page = 1; page <= 100; page++) {
      const batch = await provider(`/zones?account.id=${encodeURIComponent(cf.account_id)}&per_page=50&page=${page}&order=name`);
      for (const zone of batch) if (zone.account?.id === cf.account_id && ['full', 'partial'].includes(zone.type)) {
        zones.push({ id: zone.id, name: zone.name, status: zone.status, type: zone.type });
      }
      if (batch.length < 50) return { account_name: cf.account_name, zones, domain_access };
    }
    throw new ConnectionError('This account has too many domains to list here. Use the manual domain settings below.', 409, 'domain_list_limit');
  } catch (error) { return domainAccessError(error); }
}

function subdomain(value: unknown, field: string) {
  const label = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) throw new ConnectionError(`Enter only the ${field} subdomain, such as ${field === 'media' ? 'media' : 'sites'}. Use letters, numbers and hyphens, without dots or a URL.`, 400, 'invalid_subdomain');
  return label;
}

/** Explicit setup action: validate before saving, attach R2, then queue verified media migration. */
export async function setupOrganizationDomains(orgId: string, input: Record<string, unknown>) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('Enter domain settings.', 400);
  const current = await getOrganizationDomains(orgId);
  if (input.revision !== current.revision) throw new ConnectionError('Domain settings changed. Reload before configuring domains.', 409, 'domain_revision_conflict');
  if (typeof input.zone_id !== 'string' || !/^[a-f0-9]{32}$/.test(input.zone_id)) throw new ConnectionError('Choose a domain from your connected Cloudflare account.', 400, 'invalid_zone');
  const mediaLabel = subdomain(input.media_subdomain, 'media'), sitesLabel = subdomain(input.sites_subdomain, 'sites');
  const { cf, connection, provider } = await connectedAccount(orgId);
  if (!connectionSummary(connection).media_ready || !cf.public_bucket) throw new ConnectionError('Complete R2 media storage setup in Publishing first, then configure these domains.', 409, 'storage_required');
  let zone;
  try { zone = await provider(`/zones/${input.zone_id}`); } catch (error) { return domainAccessError(error); }
  if (zone.account?.id !== cf.account_id) throw new ConnectionError('This domain belongs to a different Cloudflare account. Select a domain in the account connected to this organization.', 409, 'domain_account_mismatch');
  if (zone.status !== 'active') throw new ConnectionError('Cloudflare has not activated this domain yet. In Cloudflare → Domains, complete its setup and wait for Active, then refresh the domain list.', 409, 'domain_zone_pending');
  if (zone.type !== 'full') throw new ConnectionError('This domain uses external DNS. Use manual settings below to see the required records.', 409, 'domain_external_dns');
  const media_host = publicationHostname(`${mediaLabel}.${zone.name}`), sites_domain = publicationHostname(`${sitesLabel}.${zone.name}`);
  const root = `/accounts/${cf.account_id}/r2/buckets/${cf.public_bucket}/domains/custom`;
  try {
    const attached = await provider(`${root}/${media_host}`, { missing: true });
    if (!attached) {
      const records = await provider(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(media_host)}&per_page=100`);
      if (records.some((record: { type: string }) => ['A', 'AAAA', 'CNAME', 'NS'].includes(record.type))) throw new ConnectionError(`${media_host} already has a DNS destination. Choose an unused subdomain or prepare a domain cutover; Typeroll has not replaced any records.`, 409, 'media_domain_cutover_required');
    } else if (!attached.enabled || attached.zoneId !== zone.id) throw new ConnectionError('This R2 media domain is disabled or belongs to a different zone. Review its Custom Domains settings in Cloudflare before retrying.', 409, 'media_domain_setup_required');
  } catch (error) { return domainAccessError(error); }
  await saveOrganizationDomains(orgId, { revision: input.revision, sites_domain, media_host, dns_mode: 'automatic' }, { queueMigration: false });
  // A provider failure after saving must return the new revision, so the same button can safely retry.
  let setup_error: string | null = null;
  try {
    await preparePublicMediaDomains(orgId, { account_id: cf.account_id, public_bucket: cf.public_bucket, media_host, website_host: '', site_prefix: '', entries: [] });
    await requestMediaMigration(orgId);
  } catch (error) {
    setup_error = (error instanceof ConnectionError || error instanceof ProviderError) && [401, 403].includes(error.status)
      ? 'Addresses saved, but Cloudflare denied setup. Allow domain access, then select Configure domains again. Your account and R2 settings are retained.'
      : error instanceof ConnectionError ? error.message : 'Addresses saved, but Cloudflare setup could not finish. Select Configure domains to retry.';
  }
  return { ...await getOrganizationDomainStatus(orgId), setup_error };
}
