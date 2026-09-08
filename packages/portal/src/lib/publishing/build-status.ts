import { paths } from '@typeroll/shared';
import { getStore } from '../datastore';
import { cloudflareClient } from './cloudflare-oauth';
import { ConnectionError, getConnection } from './connections';
import { findPublicationDeployment } from './providers.mjs';

/** Only build identity and progress leave this boundary; Pages responses also contain secret environment variables. */
export async function customerBuildStatus(orgId: string, siteId: string, jobId: string) {
  if (!jobId || /[/\\\x00-\x1f]/.test(jobId)) throw new ConnectionError('Invalid deployment ID.', 400);
  const job = await getStore().getDoc<any>(paths.deploy(orgId, siteId, jobId));
  if (!job) throw new ConnectionError('Deployment not found.', 404);
  const publication = job.git_publication;
  if (!publication?.commit) throw new ConnectionError('This deployment has not published source to GitHub yet.', 409, 'git_commit_pending');
  const connection = await getConnection(orgId, 'cloudflare');
  if (connection.cloudflare?.account_id !== publication.account_id || !/^typeroll-[a-f0-9]{16}$/.test(publication.project)) {
    throw new ConnectionError('The deployment belongs to a different publishing connection.', 409);
  }
  const provider = await cloudflareClient(orgId);
  const root = `/accounts/${publication.account_id}/pages/projects/${publication.project}`;
  const [project, match] = await Promise.all([provider(root), findPublicationDeployment(provider, root, publication)]);
  const deployment = match ? await provider(`${root}/deployments/${encodeURIComponent(match.id)}`) : null;
  return {
    job_id: jobId, status: job.status, phase: job.phase,
    source: { owner: publication.owner, repository: publication.repo, branch: publication.branch, commit: publication.commit },
    project: { name: publication.project, uses_functions: project.uses_functions ?? null,
      dashboard_url: `https://dash.cloudflare.com/${publication.account_id}/pages/view/${publication.project}` },
    deployment: deployment ? {
      id: deployment.id, commit: deployment.deployment_trigger?.metadata?.commit_hash,
      branch: deployment.deployment_trigger?.metadata?.branch, environment: deployment.environment,
      uses_functions: deployment.uses_functions ?? null, is_skipped: deployment.is_skipped === true,
      created_on: deployment.created_on,
      stages: (deployment.stages ?? []).map((stage: any) => ({ name: stage.name, status: stage.status, started_on: stage.started_on, ended_on: stage.ended_on })),
      latest_stage: { name: deployment.latest_stage?.name, status: deployment.latest_stage?.status },
    } : null,
  };
}
