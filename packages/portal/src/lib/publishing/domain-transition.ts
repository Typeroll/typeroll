import { preparePreviousHosts } from './previous-hosts';
import { domainPublicationRevision, siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { prepareRedirectHosts, redirectApprovalBlocker } from './redirect-hosts';
import { cloudflareClient } from './cloudflare-oauth';
import { hostingDns } from './hosting-dns';
import { preparePagesDomain, validationWindowAllowed } from './domain-provider';
import { siteHostingGroup } from './hosting-groups';
import { paths, type DeployJob, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getDeployQueue } from '../deploy/queue';
import { getSiteDomains } from './domain-config';
import { assertPublishingReady } from './readiness';
import { ConnectionError } from './connections';
import { readDomainCutover } from './domain-cutover-journal';
import { assertHostChecks, siteHostChecks } from './host-checks';
import { assertIndexableLaunch, indexableSettings } from './launch-robots';
import { vstore } from '../version-store';

/**
 * Whether a "distributing" switch has already ended: its job finished and no traffic journal is
 * still armed or restoring. Earlier releases left this state behind after a rollback conflict.
 */
export async function endedDistribution(orgId: string, siteId: string, domains: DomainConfiguration) {
  if (domains.state !== 'distributing' || !domains.candidate?.job_id) return false;
  const job = await getStore().getDoc<DeployJob>(paths.deploy(orgId, siteId, domains.candidate.job_id));
  if (!job || ['queued', 'running'].includes(job.status)) return false;
  const journal = await readDomainCutover(orgId, siteId, domains.candidate.id);
  return !journal || !['armed', 'rolling_back'].includes(journal.state);
}

/** End a switch whose job has finished, so a new review can read the current DNS. */
async function releaseEndedDistribution(orgId: string, siteId: string, domains: DomainConfiguration) {
  if (!await endedDistribution(orgId, siteId, domains)) return;
  await getStore().compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
    current => current.revision === domains.revision && current.state === 'distributing' && current.candidate?.id === domains.candidate!.id,
    { state: 'failed', rollback_requested: false, cutover_approved_revision: null });
}

/** A domain-only build always reuses the last public snapshot, never saved CMS changes. */
export async function prepareDomainTransition(orgId: string, siteId: string, input: Record<string, unknown>) {
  const store = getStore();
  const stored = await getSiteDomains(orgId, siteId);
  if (stored.revision === input.revision) await releaseEndedDistribution(orgId, siteId, stored);
  const [site, domains, target, jobs] = await Promise.all([
    store.getDoc<Site>(paths.site(orgId, siteId)), getSiteDomains(orgId, siteId),
    store.getDoc<any>(`${paths.site(orgId, siteId)}/publishing_targets/main`), store.listDocs<DeployJob>(paths.deploys(orgId, siteId)),
  ]);
  if (site?.publishing_mode !== 'customer_git') throw new ConnectionError('This site does not use customer publishing.', 409);
  if (domains.revision !== input.revision) throw new ConnectionError('Domain settings changed. Reload before preparing.', 409, 'domain_revision_conflict');
  if (domains.state === 'distributing') throw new ConnectionError('The traffic switch is already in progress.', 409, 'domain_cutover_in_progress');
  if (!target?.last_publication?.snapshot_job_id) throw new ConnectionError('Publish the site once before preparing a domain-only change. Normal publication uses the current or temporary address.', 409, 'first_publication_required');
  // Authored noindex/nofollow would hide the launched site; only an explicit allow_noindex_launch keeps it.
  // confirm_disable_noindex turns it off and builds a new, indexable candidate instead.
  const clearNoindex = (await assertIndexableLaunch(orgId, siteId, domains, input, { disable: true })).length > 0;
  // The deliberate choice to launch hidden is kept on the preparation job, so approval honours it too.
  const hidden = input.allow_noindex_launch === true;
  const candidateJob = jobs.find(job => job.id === domains.candidate?.job_id && job.status === 'running' && (job as any).git_publication?.publication_id === domains.candidate?.id);
  if (candidateJob && !clearNoindex && !['live', 'failed', 'outdated'].includes(domains.state) && domains.published?.publication_id === domains.candidate?.id && domains.candidate?.id === target.last_publication.publication_id && domains.candidate && domains.candidate.revision === domainPublicationRevision(domains) && domains.preparation && domains.desired.website_host) {
    const group = await siteHostingGroup(orgId, siteId);
    const publication = (candidateJob as any).git_publication;
    const refresh = async (prepared: NonNullable<DomainConfiguration['preparation']>) => {
      if (prepared.certificate_ready && !prepared.validation_blocker) return prepared;
      const provider = await cloudflareClient(orgId, fetch, undefined, group.id);
      const dns = domains.dns_mode === 'automatic' ? await hostingDns(orgId, group.id, prepared.hostname) : null;
      return preparePagesDomain(provider, { accountId: publication.account_id, project: publication.project,
        branch: 'main', hostname: prepared.hostname, configureTraffic: false, dnsMode: domains.dns_mode,
        dnsProvider: dns?.provider, dnsAccountId: dns?.accountId, orgId });
    };
    const preparation = await refresh(domains.preparation);
    const media = domains.media_preparation ? await refresh(domains.media_preparation) : null;
    const redirects = await prepareRedirectHosts(orgId, group.id, { hosts: domains.desired.redirect_hosts ?? [], target: domains.desired.website_host, dnsMode: domains.dns_mode, configureTraffic: false });
    const previousPreparations = domains.previous_host_preparations?.length ? await preparePreviousHosts(orgId, group.id,
      (domains.previous_host_preparations ?? []).map(item => item.host), domains.desired.website_host,
      await cloudflareClient(orgId, fetch, undefined, group.id), publication.account_id, publication.project) : [];
    const changed = await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
      current => current.revision === domains.revision && current.candidate?.id === domains.candidate!.id && current.state !== 'distributing' && current.state !== 'outdated',
      { preparation, media_preparation: media, previous_host_preparations: previousPreparations, redirect_preparations: redirects.length ? redirects : null,
        state: redirects.some(item => redirectApprovalBlocker(item)) || (preparation.validation_blocker && !validationWindowAllowed(preparation)) || (!preparation.certificate_ready && preparation.has_existing_traffic !== false && !validationWindowAllowed(preparation)) || (media && !media.certificate_ready && media.has_existing_traffic !== false) ? 'preparing' : 'ready_to_switch' });
    if (!changed) throw new ConnectionError('Domain settings changed. Reload before preparing.', 409, 'domain_revision_conflict');
    if (hidden) await store.updateDoc(paths.deploy(orgId, siteId, candidateJob.id), { allow_noindex_launch: true });
    return { job_id: domains.candidate.job_id ?? null, already_running: false, reused_candidate: true, candidate_id: domains.candidate.id };
  }
  const existing = !clearNoindex && domains.state !== 'outdated' && domains.published?.publication_id === domains.candidate?.id && domains.candidate?.id === target.last_publication.publication_id
    ? jobs.find(job => job.id === domains.candidate?.job_id && ['queued', 'running'].includes(job.status)) : null;
  if (existing) {
    if (hidden) await store.updateDoc(paths.deploy(orgId, siteId, existing.id), { allow_noindex_launch: true });
    return { job_id: existing.id, already_running: true };
  }
  const active = jobs.find(job => job.version_id === 'main' && ['queued', 'running'].includes(job.status) && job.phase !== 'awaiting domain cutover approval');
  if (active) return { job_id: active.id, already_running: true };
  // A host Cloudflare cannot serve (apex outside an active zone, pending zone) fails here, not after a build.
  assertHostChecks(await siteHostChecks(orgId, siteId, domains));
  await assertPublishingReady(orgId, siteId);
  if (clearNoindex) {
    // Later publications stay indexable too. The candidate itself is cleared by the job flag below,
    // because a domain-only build republishes the frozen snapshot rather than current settings.
    const settings = ((await vstore.settings(orgId, siteId, 'main')) ?? {}) as Record<string, unknown>;
    const cleared = indexableSettings(settings);
    if (!cleared) throw new ConnectionError('scripts_head contains a robots noindex tag that Typeroll cannot remove precisely. Remove it in Site settings, publish, then prepare the domain change.', 409, 'candidate_noindex_head');
    await vstore.writeSettings(orgId, siteId, 'main', { sitewide_noindex: false, sitewide_nofollow: false, ...cleared.scripts_head !== settings.scripts_head ? { scripts_head: cleared.scripts_head as string } : {} });
  }
  const jobId = await store.addDoc(paths.deploys(orgId, siteId), { version_id: 'main', environment: 'production', status: 'queued', started_at: new Date().toISOString(),
    triggered_by: 'domain preparation', publication_intent: 'domain_prepare', domain_revision: domainPublicationRevision(domains),
    source_publication: target.last_publication, ...clearNoindex ? { clear_authored_noindex: true } : {}, ...hidden ? { allow_noindex_launch: true } : {} });
  try { await getDeployQueue().enqueue({ orgId, siteId, jobId, versionId: 'main', environment: 'production' }); }
  catch { await store.updateDoc(paths.deploy(orgId, siteId, jobId), { status: 'failed', phase: 'enqueue_failed', finished_at: new Date().toISOString(), error: 'Could not queue domain preparation. Retry from Publishing.' }); throw new ConnectionError('Could not queue domain preparation. Retry from Publishing.', 502); }
  return { job_id: jobId, already_running: false, ...clearNoindex ? { noindex_disabled: true } : {} };
}
