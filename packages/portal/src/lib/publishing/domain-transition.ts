import { domainPublicationRevision, siteDomainConfigPath, type DomainConfiguration } from './domain-config';
import { prepareRedirectHosts, redirectApprovalBlocker } from './redirect-hosts';
import { validationWindowAllowed } from './domain-provider';
import { siteHostingGroup } from './hosting-groups';
import { paths, type DeployJob, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getDeployQueue } from '../deploy/queue';
import { getSiteDomains } from './domain-config';
import { assertPublishingReady } from './readiness';
import { ConnectionError } from './connections';
import { assertHostChecks, siteHostChecks } from './host-checks';

/** A domain-only build always reuses the last public snapshot, never saved CMS changes. */
export async function prepareDomainTransition(orgId: string, siteId: string, input: Record<string, unknown>) {
  const store = getStore();
  const [site, domains, target, jobs] = await Promise.all([
    store.getDoc<Site>(paths.site(orgId, siteId)), getSiteDomains(orgId, siteId),
    store.getDoc<any>(`${paths.site(orgId, siteId)}/publishing_targets/main`), store.listDocs<DeployJob>(paths.deploys(orgId, siteId)),
  ]);
  if (site?.publishing_mode !== 'customer_git') throw new ConnectionError('This site does not use customer publishing.', 409);
  if (domains.revision !== input.revision) throw new ConnectionError('Domain settings changed. Reload before preparing.', 409, 'domain_revision_conflict');
  if (domains.state === 'distributing') throw new ConnectionError('The traffic switch is already in progress.', 409, 'domain_cutover_in_progress');
  if (!target?.last_publication?.snapshot_job_id) throw new ConnectionError('Publish the site once before preparing a domain-only change. The first publication uses the hosts saved here.', 409, 'first_publication_required');
  const candidateJob = jobs.find(job => job.id === domains.candidate?.job_id && job.status === 'running' && (job as any).git_publication?.publication_id === domains.candidate?.id);
  if (candidateJob && !['live', 'failed'].includes(domains.state) && domains.candidate && domains.candidate.revision === domainPublicationRevision(domains) && domains.preparation && domains.desired.website_host) {
    const group = await siteHostingGroup(orgId, siteId);
    const redirects = await prepareRedirectHosts(orgId, group.id, { hosts: domains.desired.redirect_hosts ?? [], target: domains.desired.website_host, dnsMode: domains.dns_mode, configureTraffic: false });
    const changed = await store.compareAndUpdateDoc<DomainConfiguration>(siteDomainConfigPath(orgId, siteId),
      current => current.revision === domains.revision && current.candidate?.id === domains.candidate!.id && current.state !== 'distributing',
      { redirect_preparations: redirects.length ? redirects : null,
        state: redirects.some(item => redirectApprovalBlocker(item)) || (domains.preparation.validation_blocker && !validationWindowAllowed(domains.preparation)) || (domains.media_preparation && !domains.media_preparation.certificate_ready && domains.media_preparation.has_existing_traffic !== false) ? 'preparing' : 'ready_to_switch' });
    if (!changed) throw new ConnectionError('Domain settings changed. Reload before preparing.', 409, 'domain_revision_conflict');
    return { job_id: domains.candidate.job_id ?? null, already_running: false, reused_candidate: true, candidate_id: domains.candidate.id };
  }
  const active = jobs.find(job => job.version_id === 'main' && ['queued', 'running'].includes(job.status));
  if (active) return { job_id: active.id, already_running: true };
  // A host Cloudflare cannot serve (apex outside an active zone, pending zone) fails here, not after a build.
  assertHostChecks(await siteHostChecks(orgId, siteId, domains));
  await assertPublishingReady(orgId, siteId);
  const jobId = await store.addDoc(paths.deploys(orgId, siteId), { version_id: 'main', environment: 'production', status: 'queued', started_at: new Date().toISOString(),
    triggered_by: 'domain preparation', publication_intent: 'domain_prepare', domain_revision: domainPublicationRevision(domains),
    source_publication: target.last_publication });
  try { await getDeployQueue().enqueue({ orgId, siteId, jobId, versionId: 'main', environment: 'production' }); }
  catch { await store.updateDoc(paths.deploy(orgId, siteId, jobId), { status: 'failed', phase: 'enqueue_failed', finished_at: new Date().toISOString(), error: 'Could not queue domain preparation. Retry from Publishing.' }); throw new ConnectionError('Could not queue domain preparation. Retry from Publishing.', 502); }
  return { job_id: jobId, already_running: false };
}
