import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from './connections';

export interface PublicationHosts {
  website_host: string | null;
  media_host: string | null;
  media_path_prefix: string;
  /** Hosts that answer 301 to website_host. Omitted when empty so existing configurations keep their identity. */
  redirect_hosts?: string[];
}

/** Datastores may reorder map fields; host identity must depend on values only. Media aliases compare these three values. */
export function samePublicationHosts(left: PublicationHosts, right: PublicationHosts): boolean {
  return left.website_host === right.website_host && left.media_host === right.media_host && left.media_path_prefix === right.media_path_prefix;
}

/** A change of redirect hosts is a domain change that needs preparation and approval. */
export function sameRedirectHosts(left: PublicationHosts, right: PublicationHosts): boolean {
  return JSON.stringify([...left.redirect_hosts ?? []].sort()) === JSON.stringify([...right.redirect_hosts ?? []].sort());
}

export interface DomainConfiguration {
  validation_timeout_minutes?: number;
  rollback_requested?: boolean;
  rollback_status?: 'rolled_back' | 'conflict';
  revision: string;
  /** Output identity stays stable when only edge redirect hosts change. */
  publication_revision?: string;
  desired: PublicationHosts;
  active: PublicationHosts | null;
  /** Origins embedded in the single deployed main output; traffic may still use active. */
  published?: { hosts: PublicationHosts; dns_mode: 'automatic' | 'external'; publication_id: string; job_id?: string } | null;
  active_dns_mode?: 'automatic' | 'external';
  /** Retained aliases are never removed as a side effect of changing the preferred host. */
  media_aliases: PublicationHosts[];
  previous_hosts?: import('./previous-hosts').PreviousHost[];
  previous_host_preparations?: import('./previous-hosts').PreviousHostPreparation[] | null;
  approved_previous_host_preparations?: import('./previous-hosts').PreviousHostPreparation[] | null;
  dns_mode: 'automatic' | 'external';
  state: 'unconfigured' | 'declared' | 'preparing' | 'ready_to_switch' | 'distributing' | 'live' | 'failed' | 'outdated';
  candidate?: { id: string; revision: string; commit: string; deployment_id: string; verified_at: string; job_id?: string; sitewide_noindex?: boolean; robots_blocked?: boolean; source_publication_id?: string } | null;
  preparation?: import('./domain-provider').DomainPreparation | null;
  media_preparation?: import('./domain-provider').DomainPreparation | null;
  approved_media_preparation?: import('./domain-provider').DomainPreparation | null;
  cutover_approved_revision?: string | null;
  approved_preparation?: import('./domain-provider').DomainPreparation | null;
  redirect_preparations?: import('./redirect-hosts').RedirectPreparation[] | null;
  approved_redirect_preparations?: import('./redirect-hosts').RedirectPreparation[] | null;
  /** Explicit acceptance that the website host is unavailable until Cloudflare validates it after the record change. */
  approved_validation_window?: boolean | null;
  /** Follow-up checks of who serves the live website host; an alarm stands until a check proves it served again. */
  serving_check?: import('./serving-check').ServingCheck | null;
}

/** Effective output origins. Saving future settings is inert; explicit publication selects them. */
export function hasPendingPublishedDomains(config: DomainConfiguration): boolean {
  return Boolean(config.published && (!config.active || !samePublicationHosts(config.published.hosts, config.active) || !sameRedirectHosts(config.published.hosts, config.active)));
}

/** Normal edits retain the origins already embedded in main, even before DNS switches. */
export function activePublicationDomains(config: DomainConfiguration, verifiedMigrationHost?: string): DomainConfiguration {
  return { ...config, desired: config.published?.hosts ?? config.active ?? { website_host: verifiedMigrationHost ?? null, media_host: null, media_path_prefix: '' },
    dns_mode: config.published?.dns_mode ?? config.active_dns_mode ?? config.dns_mode };
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
  const redirect_hosts = parseRedirectHosts(input.redirect_hosts, website_host, media_host);
  return { website_host, media_host, media_path_prefix, ...(redirect_hosts.length ? { redirect_hosts } : {}) };
}

/** Accept an array or a comma/space separated list of hostnames that redirect to the website host. */
export function parseRedirectHosts(input: unknown, websiteHost: string | null, mediaHost: string | null): string[] {
  if (input == null || input === '') return [];
  const values = typeof input === 'string' ? input.split(/[\s,]+/).filter(Boolean) : input;
  if (!Array.isArray(values)) throw new ConnectionError('Enter redirect hosts as a list of hostnames.', 400, 'invalid_hostname');
  const hosts = [...new Set(values.map(value => publicationHostname(value)))].sort();
  if (hosts.length && !websiteHost) throw new ConnectionError('Set a website host before adding hosts that redirect to it.', 400, 'website_host_required');
  if (hosts.length > 4) throw new ConnectionError('Enter at most four redirect hosts.', 400, 'too_many_redirect_hosts');
  for (const host of hosts) {
    if (host === websiteHost || host === mediaHost) throw new ConnectionError(`${host} already serves the website or media, so it cannot redirect to the website host.`, 400, 'redirect_host_conflict');
  }
  return hosts;
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
    for (const job of await store.listDocs<{ git_publication?: { snapshot_chunks: number; snapshot_digest: string; snapshot_format?: 1 } }>(paths.deploys(orgId, site.id))) {
      if (!job.git_publication) continue;
      const publication = job.git_publication;
      if (!Number.isInteger(publication.snapshot_chunks) || publication.snapshot_chunks < 1 || publication.snapshot_chunks > 250) return false;
      let snapshot: string;
      try {
        const { readSnapshot } = await import('./publication-snapshot');
        snapshot = JSON.stringify(await readSnapshot({ orgId, siteId: site.id, jobId: job.id }, publication));
      } catch { return false; }
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
export function domainPublicationRevision(config: DomainConfiguration): string {
  return config.publication_revision ?? config.revision;
}

export async function saveSiteDomains(orgId: string, siteId: string, input: Record<string, unknown>) {
  const previous = await getSiteDomains(orgId, siteId);
  const desired = parsePublicationHosts(input);
  if (!['automatic', 'external'].includes(String(input.dns_mode))) throw new ConnectionError('Select automatic or external DNS management.', 400);
  if (previous.revision !== input.revision) throw new ConnectionError('Domain settings changed. Reload before saving.', 409, 'domain_revision_conflict');
  const sameOutput = samePublicationHosts(previous.desired, desired);
  if (sameOutput && sameRedirectHosts(previous.desired, desired) && previous.dns_mode === input.dns_mode) return previous;
  if (previous.state === 'distributing') throw new ConnectionError('A traffic switch is in progress. Wait for it to finish before changing domain settings.', 409, 'domain_cutover_in_progress');
  const revision = randomUUID();
  const preserveCandidate = sameOutput && Boolean(previous.candidate) && !['live', 'failed'].includes(previous.state);
  const changed = await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
    current => current.revision === input.revision && current.state !== 'distributing',
    { revision, publication_revision: sameOutput ? domainPublicationRevision(previous) : revision, desired, dns_mode: input.dns_mode,
      ...(previous.active ? { active_dns_mode: previous.active_dns_mode ?? previous.dns_mode } : {}),
      state: previous.state === 'outdated' && preserveCandidate ? 'outdated' : preserveCandidate ? 'preparing' : 'declared',
      ...(!preserveCandidate ? { candidate: null } : {}),
      ...(sameOutput ? {} : { preparation: null, media_preparation: null }),
      approved_media_preparation: null, cutover_approved_revision: null, approved_preparation: null,
      redirect_preparations: null, approved_redirect_preparations: null, previous_host_preparations: null, approved_previous_host_preparations: null, approved_validation_window: null });
  if (!changed) throw new ConnectionError('Domain settings changed. Reload before saving.', 409, 'domain_revision_conflict');
  if (!sameOutput && previous.candidate?.job_id) await getStore().compareAndUpdateDoc<any>(paths.deploy(orgId, siteId, previous.candidate.job_id),
    job => job.status === 'running' && job.phase === 'awaiting domain cutover approval',
    { status: previous.published?.publication_id === previous.candidate.id ? 'succeeded' : 'failed', phase: 'superseded', finished_at: new Date().toISOString(), error: null });
  return getSiteDomains(orgId, siteId);
}

export async function approveDomainCutover(orgId: string, siteId: string, input: Record<string, unknown>) {
  const current = await getSiteDomains(orgId, siteId);
  if (!input || input.revision !== current.revision || input.candidate_id !== current.candidate?.id || !current.candidate || current.candidate.revision !== domainPublicationRevision(current)) {
    throw new ConnectionError('The prepared deployment changed. Verify the current candidate before switching traffic.', 409, 'domain_revision_conflict');
  }
  const target = await getStore().getDoc<any>(`${paths.site(orgId, siteId)}/publishing_targets/main`);
  if (current.state === 'outdated' || current.published?.publication_id !== current.candidate.id || target?.last_publication?.publication_id !== current.candidate.id) {
    throw new ConnectionError('Publish for the new domain before switching traffic. The approval must refer to the current main publication.', 409, 'domain_candidate_outdated');
  }
  if (target?.job_id && target.job_id !== current.candidate.job_id) {
    const activeJob = await getStore().getDoc<any>(paths.deploy(orgId, siteId, target.job_id));
    if (activeJob && ['queued', 'running'].includes(activeJob.status)) throw new ConnectionError('A publication is in progress. Wait for it to finish, then review the latest publication before switching DNS.', 409, 'publication_in_progress');
  }
  if (['failed', 'live'].includes(current.state)) throw new ConnectionError('Prepare and verify a current candidate before switching traffic.', 409, 'publication_unavailable');
  // The candidate itself or the settings for later publications must not hide the launched site, unless explicitly allowed.
  if (current.state !== 'distributing') await (await import('./launch-robots')).assertIndexableLaunch(orgId, siteId, current, input);
  if (current.candidate.job_id) {
    const job = await getStore().getDoc<any>(paths.deploy(orgId, siteId, current.candidate.job_id));
    if (job?.status !== 'running' || job.git_publication?.publication_id !== current.candidate.id) throw new ConnectionError('The prepared publication is no longer available. Prepare the domain change again.', 409, 'publication_unavailable');
  }
  const timeout = current.state === 'distributing' ? current.validation_timeout_minutes ?? 15 : input.validation_timeout_minutes ?? 15;
  if (!Number.isInteger(timeout) || Number(timeout) < 5 || Number(timeout) > 45) throw new ConnectionError('Choose a validation window between 5 and 45 minutes.', 400, 'invalid_validation_window');
  const preparation = current.preparation;
  const mediaPreparation = current.media_preparation;
  if (mediaPreparation && !mediaPreparation.certificate_ready && mediaPreparation.has_existing_traffic !== false) throw new ConnectionError('The media hostname is not ready for a safe traffic switch. Complete media domain validation first.', 409, 'media_domain_certificate_pending');
  const { validationWindowAllowed } = await import('./domain-provider');
  const acceptWindow = input.accept_validation_window === true;
  if (acceptWindow && !validationWindowAllowed(preparation)) throw new ConnectionError('A validation window can be accepted only when Cloudflare cannot validate the website host before its single reviewed record changes.', 409, 'validation_window_not_applicable');
  if (!acceptWindow && preparation?.validation_blocker) throw new ConnectionError(preparation.validation_blocker.message, 409, validationWindowAllowed(preparation) ? 'validation_window_acceptance_required' : preparation.validation_blocker.code);
  if (!preparation || (!preparation.certificate_ready && preparation.has_existing_traffic !== false && !acceptWindow)) {
    throw new ConnectionError('Cloudflare has not confirmed a working certificate. Complete validation while keeping current DNS in place. Traffic cannot be switched safely yet.', 409, 'domain_certificate_pending');
  }
  const redirectPreparations = current.redirect_preparations ?? null;
  const previousPreparations = current.previous_host_preparations ?? null;
  const { redirectApprovalBlocker } = await import('./redirect-hosts');
  if ((current.desired.redirect_hosts?.length ?? 0) !== (redirectPreparations?.length ?? 0) || (redirectPreparations ?? []).some(item => !current.desired.redirect_hosts?.includes(item.hostname) || item.target_host !== current.desired.website_host)) throw new ConnectionError('The redirect hosts have not been prepared yet. Wait for domain verification to finish.', 409, 'redirect_preparation_pending');
  for (const redirect of redirectPreparations ?? []) {
    const blocker = redirectApprovalBlocker(redirect);
    if (blocker) throw new ConnectionError(blocker.message, 409, blocker.code);
  }
  // Reserve the same target used by the runner while accepting approval. A
  // publication that starts between the earlier read and this write must win
  // the lock or receive a conflict, never race an approved DNS switch.
  const targetPath = `${paths.site(orgId, siteId)}/publishing_targets/main`;
  const approvalLease = randomUUID();
  if (current.candidate.job_id) {
    const reserved = await getStore().compareAndUpdateDoc<any>(targetPath,
      value => value.last_publication?.publication_id === current.candidate!.id &&
        (!value.job_id || value.job_id === current.candidate!.job_id) && (value.lease_until ?? 0) < Date.now(),
      { job_id: current.candidate.job_id, lease_id: approvalLease, lease_until: Date.now() + 30_000 });
    if (!reserved) throw new ConnectionError('A publication is in progress. Review its result before switching DNS.', 409, 'publication_in_progress');
  }
  let approved = false;
  try {
    const saved = await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
      value => value.published?.publication_id === current.candidate!.id && value.state !== 'outdated' && value.revision === current.revision && value.candidate?.id === current.candidate!.id && JSON.stringify(value.preparation) === JSON.stringify(preparation) && JSON.stringify(value.media_preparation) === JSON.stringify(mediaPreparation) &&
        JSON.stringify(value.redirect_preparations ?? null) === JSON.stringify(redirectPreparations) &&
        JSON.stringify(value.previous_host_preparations ?? null) === JSON.stringify(previousPreparations),
      { validation_timeout_minutes: Number(timeout), rollback_requested: false, rollback_status: null, cutover_approved_revision: current.revision, approved_preparation: preparation, approved_media_preparation: mediaPreparation ?? null, approved_redirect_preparations: redirectPreparations, approved_previous_host_preparations: previousPreparations, approved_validation_window: acceptWindow || null, state: 'distributing' });
    if (!saved) throw new ConnectionError('Domain verification changed. Reload before switching traffic.', 409, 'domain_revision_conflict');
    approved = true;
  } finally {
    if (current.candidate.job_id) await getStore().compareAndUpdateDoc<any>(targetPath,
      value => value.lease_id === approvalLease,
      { lease_id: null, lease_until: 0, ...(!approved ? { job_id: null } : {}) });
  }
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

export async function saveOrganizationDomains(orgId: string, input: Record<string, unknown>, options: { prepareMediaDomain?: boolean } = {}) {
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
  // Site media does not depend on these hosts. Only a new media host needs
  // Organization work: attaching it to the public bucket.
  if (options.prepareMediaDomain !== false && media_host && media_host !== current.media_host) {
    const { requestOrganizationMediaDomain } = await import('./media-migration');
    await requestOrganizationMediaDomain(orgId);
  }
  return getOrganizationDomains(orgId);
}
