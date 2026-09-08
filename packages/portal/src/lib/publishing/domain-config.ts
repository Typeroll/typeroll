import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from './connections';

export interface PublicationHosts {
  website_host: string | null;
  media_host: string | null;
  media_path_prefix: string;
}

/** Datastores may reorder map fields; host identity must depend on values only. */
export function samePublicationHosts(left: PublicationHosts, right: PublicationHosts): boolean {
  return left.website_host === right.website_host && left.media_host === right.media_host && left.media_path_prefix === right.media_path_prefix;
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
  media_preparation?: import('./domain-provider').DomainPreparation | null;
  approved_media_preparation?: import('./domain-provider').DomainPreparation | null;
  cutover_approved_revision?: string | null;
  approved_preparation?: import('./domain-provider').DomainPreparation | null;
}

export interface OrganizationDomains {
  revision: string;
  /** Legacy input used for both hosts. New clients use sites_domain and media_host. */
  default_domain: string | null;
  sites_domain: string | null;
  media_host: string | null;
  dns_mode: 'automatic' | 'external';
  verified_at: string | null;
  /** Durable protection even after media records or deployment history are deleted. */
  media_host_used_at?: string | null;
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
    revision: randomUUID(), default_domain: null, sites_domain: null, media_host: null, dns_mode: 'automatic', verified_at: null,
  } satisfies OrganizationDomains);
  const saved = (await getStore().getDoc<OrganizationDomains>(path))!;
  return { ...saved, sites_domain: Object.hasOwn(saved, 'sites_domain') ? saved.sites_domain : saved.default_domain,
    media_host: Object.hasOwn(saved, 'media_host') ? saved.media_host : saved.default_domain };
}

/** Only unused, unverified hostnames can be corrected without an alias migration. */
export async function canReplaceOrganizationMediaHost(orgId: string, current: OrganizationDomains): Promise<boolean> {
  if (!current.media_host) return true;
  if (current.verified_at || current.media_host_used_at) return false;
  const store = getStore();
  for (const site of await store.listDocs(paths.sites(orgId))) {
    if ((await store.listDocs(paths.media(orgId, site.id), { limit: 1 })).length) return false;
    // Older releases did not record host use. Include every version's frozen
    // deployments: deleting a CMS media record does not unpublish its URLs.
    for (const job of await store.listDocs<{ git_publication?: { snapshot_chunks: number; snapshot_digest: string } }>(paths.deploys(orgId, site.id))) {
      if (!job.git_publication) continue;
      const publication = job.git_publication;
      if (!Number.isInteger(publication.snapshot_chunks) || publication.snapshot_chunks < 1 || publication.snapshot_chunks > 250) return false;
      let snapshot = '';
      for (let i = 0; i < publication.snapshot_chunks; i++) {
        const chunk = await store.getDoc<{ data: string }>(`${paths.deploy(orgId, site.id, job.id)}/snapshot_chunks/${String(i).padStart(4, '0')}`);
        if (typeof chunk?.data !== 'string') return false;
        snapshot += chunk.data;
      }
      if (createHash('sha256').update(snapshot).digest('hex') !== publication.snapshot_digest) return false;
      if (snapshot.includes(`https://${current.media_host}/`) || snapshot.includes(`http://${current.media_host}/`)) return false;
    }
  }
  return true;
}

/** Reserve the origin before freezing URLs, atomically against a settings change. */
export async function markOrganizationMediaHostUsed(orgId: string, current: OrganizationDomains) {
  if (!current.media_host) return;
  const saved = await getStore().compareAndUpdateDoc<OrganizationDomains>(organizationDomainConfigPath(orgId),
    value => value.revision === current.revision,
    { media_host_used_at: current.media_host_used_at ?? new Date().toISOString() });
  if (!saved) throw new ConnectionError('Organization domains changed. Retry publishing with the current settings.', 409, 'domain_revision_conflict');
}

/** Saving intent cannot perform DNS writes, change live origins or publish content. */
export async function saveSiteDomains(orgId: string, siteId: string, input: Record<string, unknown>) {
  const previous = await getSiteDomains(orgId, siteId);
  const desired = parsePublicationHosts(input);
  if (!['automatic', 'external'].includes(String(input.dns_mode))) throw new ConnectionError('Select automatic or external DNS management.', 400);
  const revision = randomUUID();
  const changed = await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
    current => current.revision === input.revision,
    { revision, desired, dns_mode: input.dns_mode, state: 'declared', candidate: null, preparation: null, media_preparation: null, approved_media_preparation: null, cutover_approved_revision: null, approved_preparation: null });
  if (!changed) throw new ConnectionError('Domain settings changed. Reload before saving.', 409, 'domain_revision_conflict');
  if (previous.candidate?.job_id) await getStore().compareAndUpdateDoc<any>(paths.deploy(orgId, siteId, previous.candidate.job_id),
    job => job.status === 'running' && job.phase === 'awaiting domain cutover approval',
    { status: 'failed', phase: 'superseded', finished_at: new Date().toISOString(), error: 'Domain settings changed. Prepare a new candidate with the saved hosts.' });
  return getSiteDomains(orgId, siteId);
}

export async function approveDomainCutover(orgId: string, siteId: string, input: Record<string, unknown>) {
  const current = await getSiteDomains(orgId, siteId);
  if (!input || input.revision !== current.revision || input.candidate_id !== current.candidate?.id || !current.candidate || current.candidate.revision !== current.revision) {
    throw new ConnectionError('The prepared deployment changed. Verify the current candidate before switching traffic.', 409, 'domain_revision_conflict');
  }
  const preparation = current.preparation;
  const mediaPreparation = current.media_preparation;
  if (mediaPreparation && !mediaPreparation.certificate_ready && mediaPreparation.has_existing_traffic !== false) throw new ConnectionError('The media hostname is not ready for a safe traffic switch. Complete media domain validation first.', 409, 'media_domain_certificate_pending');
  if (!preparation || (!preparation.certificate_ready && preparation.has_existing_traffic !== false)) {
    throw new ConnectionError('Cloudflare has not confirmed a working certificate. Complete validation while keeping current DNS in place. Traffic cannot be switched safely yet.', 409, 'domain_certificate_pending');
  }
  const saved = await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
    value => value.revision === current.revision && value.candidate?.id === current.candidate!.id && JSON.stringify(value.preparation) === JSON.stringify(preparation) && JSON.stringify(value.media_preparation) === JSON.stringify(mediaPreparation),
    { cutover_approved_revision: current.revision, approved_preparation: preparation, approved_media_preparation: mediaPreparation ?? null, state: 'distributing' });
  if (!saved) throw new ConnectionError('Domain verification changed. Reload before switching traffic.', 409, 'domain_revision_conflict');
  if (current.candidate.job_id) {
    const { getDeployQueue } = await import('../deploy/queue');
    const jobId = current.candidate.job_id;
    const jobPath = paths.deploy(orgId, siteId, jobId);
    const resumed = await getStore().compareAndUpdateDoc<any>(jobPath,
      job => job.status === 'running' && job.git_publication?.publication_id === current.candidate!.id,
      { observation_started_at: new Date().toISOString() });
    if (!resumed) throw new ConnectionError('The prepared publication is no longer available. Prepare the domain change again.', 409, 'publication_unavailable');
    try { await getDeployQueue().enqueue({ orgId, siteId, jobId, versionId: 'main', environment: 'production',
      dispatchKey: createHash('sha256').update(`cutover:${current.revision}:${current.candidate.id}`).digest('hex').slice(0, 16) }); }
    catch { throw new ConnectionError('The traffic switch was approved, but could not be queued. Retry the approval to resume the same verified publication.', 502, 'cutover_enqueue_failed'); }
  }
  return getSiteDomains(orgId, siteId);
}

export async function saveOrganizationDomains(orgId: string, input: Record<string, unknown>, options: { queueMigration?: boolean } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('Enter domain settings.', 400);
  if (!['automatic', 'external'].includes(String(input.dns_mode))) throw new ConnectionError('Select automatic or external DNS management.', 400);
  const current = await getOrganizationDomains(orgId);
  const hostname = (key: string, previous: string | null) => Object.hasOwn(input, key)
    ? input[key] ? publicationHostname(input[key]) : null : previous;
  if (Object.hasOwn(input, 'default_domain') && current.sites_domain !== current.media_host &&
      (!Object.hasOwn(input, 'sites_domain') || !Object.hasOwn(input, 'media_host'))) {
    throw new ConnectionError('This organization uses separate site and media hosts. Send sites_domain and media_host explicitly.', 400, 'separate_hosts_required');
  }
  const legacy = hostname('default_domain', current.default_domain);
  const sites_domain = hostname('sites_domain', Object.hasOwn(input, 'default_domain') ? legacy : current.sites_domain);
  const media_host = hostname('media_host', Object.hasOwn(input, 'default_domain') ? legacy : current.media_host);
  const replacingMediaHost = Boolean(current.media_host && current.media_host !== media_host);
  if (replacingMediaHost && !await canReplaceOrganizationMediaHost(orgId, current)) {
    throw new ConnectionError('The existing shared media host must remain available for published media. Prepare a domain migration before replacing it.', 409, 'domain_migration_required');
  }
  const changed = await getStore().compareAndUpdateDoc<OrganizationDomains>(organizationDomainConfigPath(orgId),
    value => value.revision === input.revision && (!replacingMediaHost || (!value.media_host_used_at && !value.verified_at)),
    { revision: randomUUID(), default_domain: legacy, sites_domain, media_host, dns_mode: input.dns_mode,
      verified_at: current.media_host === media_host ? current.verified_at : null });
  if (!changed) throw new ConnectionError('Domain settings changed. Reload before saving.', 409, 'domain_revision_conflict');
  if (options.queueMigration !== false) {
    const { requestMediaMigration } = await import('./media-migration');
    await requestMediaMigration(orgId);
  }
  return getOrganizationDomains(orgId);
}
