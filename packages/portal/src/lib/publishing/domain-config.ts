import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from './connections';

export interface PublicationHosts {
  website_host: string | null;
  media_host: string | null;
  media_path_prefix: string;
}

export interface DomainConfiguration {
  revision: string;
  desired: PublicationHosts;
  active: PublicationHosts | null;
  /** Retained aliases are never removed as a side effect of changing the preferred host. */
  media_aliases: PublicationHosts[];
  dns_mode: 'automatic' | 'external';
  state: 'unconfigured' | 'declared' | 'preparing' | 'ready_to_switch' | 'distributing' | 'live' | 'failed';
  candidate?: { id: string; revision: string; commit: string; deployment_id: string; verified_at: string; job_id?: string } | null;
  preparation?: import('./domain-provider').DomainPreparation | null;
  cutover_approved_revision?: string | null;
  approved_preparation?: import('./domain-provider').DomainPreparation | null;
}

export interface OrganizationDomains {
  revision: string;
  default_domain: string | null;
  dns_mode: 'automatic' | 'external';
  verified_at: string | null;
}

/** Accept a hostname, never a URL, IP address, path, wildcard or private name. */
export function publicationHostname(input: unknown): string {
  if (typeof input !== 'string' || input !== input.trim() || /[\s/:\\@?#*%]/.test(input)) {
    throw new ConnectionError('Enter a hostname such as www.example.com, without https:// or a path.', 400, 'invalid_hostname');
  }
  const host = domainToASCII(input).toLowerCase();
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels.at(-1)!) || ['localhost', 'local', 'internal', 'invalid', 'test'].includes(labels.at(-1)!)) {
    throw new ConnectionError('Enter a valid public hostname.', 400, 'invalid_hostname');
  }
  return host;
}

/** Stable public paths may preserve a legacy layout, but must not escape the asset namespace. */
export function publicMediaPath(input: unknown): string {
  if (typeof input !== 'string' || !input.startsWith('/') || input.length > 2048 || /[\\?#\x00-\x20\x7f]/.test(input)) {
    throw new ConnectionError('Enter an absolute media path without a hostname, query or fragment.', 400, 'invalid_media_path');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(input); } catch { throw new ConnectionError('Invalid media path encoding.', 400, 'invalid_media_path'); }
  const parts = decoded.split('/').slice(1);
  if (/[\\%?#\x00-\x20\x7f]/.test(decoded) || parts.some(part => !part || part === '.' || part === '..') ||
      /^\/(?:\.git|\.well-known|_typeroll|_worker\.js|_headers|_redirects)(?:\/|$)/i.test(decoded)) {
    throw new ConnectionError('This media path is reserved or unsafe.', 400, 'invalid_media_path');
  }
  return input;
}

export function parsePublicationHosts(input: Record<string, unknown>): PublicationHosts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('Enter domain settings.', 400);
  const website_host = input.website_host ? publicationHostname(input.website_host) : null;
  const media_host = input.media_host ? publicationHostname(input.media_host) : null;
  const prefix = input.media_path_prefix ?? (website_host && website_host === media_host ? '/media' : '');
  if (typeof prefix !== 'string') throw new ConnectionError('Enter a media path prefix.', 400);
  const media_path_prefix = prefix === '' ? '' : publicMediaPath(prefix);
  if (website_host && website_host === media_host && !media_path_prefix) {
    throw new ConnectionError('Media on the website host needs a path prefix, such as /media.', 400, 'media_prefix_required');
  }
  return { website_host, media_host, media_path_prefix };
}

export function siteDomainConfigPath(orgId: string, siteId: string): string {
  identity(orgId); identity(siteId);
  return `${paths.site(orgId, siteId)}/publishing/domains`;
}

function identity(value: string) {
  if (!value || /[/\\\x00-\x1f]/.test(value) || value === '.' || value === '..') throw new ConnectionError('Invalid publishing identity');
}

export function organizationDomainConfigPath(orgId: string): string {
  identity(orgId);
  return `${paths.org(orgId)}/publishing/domains`;
}

export async function getSiteDomains(orgId: string, siteId: string): Promise<DomainConfiguration> {
  const path = siteDomainConfigPath(orgId, siteId);
  await getStore().createDocIfMissing(path, {
    revision: randomUUID(), desired: { website_host: null, media_host: null, media_path_prefix: '' },
    active: null, media_aliases: [], dns_mode: 'automatic', state: 'unconfigured',
  } satisfies DomainConfiguration);
  return (await getStore().getDoc<DomainConfiguration>(path))!;
}

export async function getOrganizationDomains(orgId: string): Promise<OrganizationDomains> {
  const path = organizationDomainConfigPath(orgId);
  await getStore().createDocIfMissing(path, {
    revision: randomUUID(), default_domain: null, dns_mode: 'automatic', verified_at: null,
  } satisfies OrganizationDomains);
  return (await getStore().getDoc<OrganizationDomains>(path))!;
}

/** Saving intent cannot perform DNS writes, change live origins or publish content. */
export async function saveSiteDomains(orgId: string, siteId: string, input: Record<string, unknown>) {
  const desired = parsePublicationHosts(input);
  if (!['automatic', 'external'].includes(String(input.dns_mode))) throw new ConnectionError('Select automatic or external DNS management.', 400);
  const revision = randomUUID();
  const changed = await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
    current => current.revision === input.revision,
    { revision, desired, dns_mode: input.dns_mode, state: 'declared', candidate: null, preparation: null, cutover_approved_revision: null, approved_preparation: null });
  if (!changed) throw new ConnectionError('Domain settings changed. Reload before saving.', 409, 'domain_revision_conflict');
  return getSiteDomains(orgId, siteId);
}

export async function approveDomainCutover(orgId: string, siteId: string, input: Record<string, unknown>) {
  const current = await getSiteDomains(orgId, siteId);
  if (!input || input.revision !== current.revision || input.candidate_id !== current.candidate?.id || !current.candidate || current.candidate.revision !== current.revision) {
    throw new ConnectionError('The prepared deployment changed. Verify the current candidate before switching traffic.', 409, 'domain_revision_conflict');
  }
  const preparation = current.preparation;
  if (!preparation || (!preparation.certificate_ready && preparation.has_existing_traffic !== false)) {
    throw new ConnectionError('Cloudflare has not confirmed a working certificate. Complete validation while keeping current DNS in place. Traffic cannot be switched safely yet.', 409, 'domain_certificate_pending');
  }
  const saved = await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
    value => value.revision === current.revision && value.candidate?.id === current.candidate!.id && JSON.stringify(value.preparation) === JSON.stringify(preparation),
    { cutover_approved_revision: current.revision, approved_preparation: preparation, state: 'distributing' });
  if (!saved) throw new ConnectionError('Domain verification changed. Reload before switching traffic.', 409, 'domain_revision_conflict');
  return getSiteDomains(orgId, siteId);
}

export async function saveOrganizationDomains(orgId: string, input: Record<string, unknown>) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('Enter domain settings.', 400);
  const default_domain = input.default_domain ? publicationHostname(input.default_domain) : null;
  if (!['automatic', 'external'].includes(String(input.dns_mode))) throw new ConnectionError('Select automatic or external DNS management.', 400);
  const current = await getOrganizationDomains(orgId);
  if (current.default_domain && current.default_domain !== default_domain) {
    // Removing an origin requires a separate alias/dependency migration, never a plain settings overwrite.
    throw new ConnectionError('The existing default domain must remain available for published sites and media. Prepare a domain migration before replacing it.', 409, 'domain_migration_required');
  }
  const changed = await getStore().compareAndUpdateDoc<OrganizationDomains>(organizationDomainConfigPath(orgId),
    value => value.revision === input.revision,
    { revision: randomUUID(), default_domain, dns_mode: input.dns_mode,
      verified_at: current.default_domain === default_domain ? current.verified_at : null });
  if (!changed) throw new ConnectionError('Domain settings changed. Reload before saving.', 409, 'domain_revision_conflict');
  const { requestMediaMigration } = await import('./media-migration');
  await requestMediaMigration(orgId);
  return getOrganizationDomains(orgId);
}
