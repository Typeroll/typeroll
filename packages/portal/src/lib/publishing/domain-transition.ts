import { paths, type DeployJob, type Site } from '@typeroll/shared';
import { getStore } from '../datastore';
import { getDeployQueue } from '../deploy/queue';
import { getSiteDomains } from './domain-config';
import { assertPublishingReady } from './readiness';
import { ConnectionError } from './connections';

/** A domain-only build always reuses the last public snapshot, never saved CMS changes. */
export async function prepareDomainTransition(orgId: string, siteId: string, input: Record<string, unknown>) {
  const store = getStore();
  const [site, domains, target, jobs] = await Promise.all([
    store.getDoc<Site>(paths.site(orgId, siteId)), getSiteDomains(orgId, siteId),
    store.getDoc<any>(`${paths.site(orgId, siteId)}/publishing_targets/main`), store.listDocs<DeployJob>(paths.deploys(orgId, siteId)),
  ]);
  if (site?.publishing_mode !== 'customer_git') throw new ConnectionError('This site does not use customer publishing.', 409);
  if (domains.revision !== input.revision) throw new ConnectionError('Domain settings changed. Reload before preparing.', 409, 'domain_revision_conflict');
  if (!target?.last_publication?.snapshot_job_id) throw new ConnectionError('Publish the site once before preparing a domain-only change. The first publication uses the hosts saved here.', 409, 'first_publication_required');
  const active = jobs.find(job => job.version_id === 'main' && ['queued', 'running'].includes(job.status));
  if (active) return { job_id: active.id, already_running: true };
  await assertPublishingReady(orgId, siteId);
  const jobId = await store.addDoc(paths.deploys(orgId, siteId), { version_id: 'main', environment: 'production', status: 'queued', started_at: new Date().toISOString(),
    triggered_by: 'domain preparation', publication_intent: 'domain_prepare', domain_revision: domains.revision,
    source_publication: target.last_publication });
  try { await getDeployQueue().enqueue({ orgId, siteId, jobId, versionId: 'main', environment: 'production' }); }
  catch { await store.updateDoc(paths.deploy(orgId, siteId, jobId), { status: 'failed', phase: 'enqueue_failed', finished_at: new Date().toISOString(), error: 'Could not queue domain preparation. Retry from Publishing.' }); throw new ConnectionError('Could not queue domain preparation. Retry from Publishing.', 502); }
  return { job_id: jobId, already_running: false };
}
