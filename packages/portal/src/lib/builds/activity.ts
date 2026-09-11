import { randomUUID } from 'node:crypto';
import { paths, type DeployJob } from '@typeroll/shared';
import { getStore } from '../datastore';
import { ConnectionError } from '../publishing/connections';
import { OrganizationBuildQueue, buildTasksPath, type BuildTask } from './queue';
import { buildInputPath, readEngineConfiguration, engineConfigurationPath, type BuildInput, type EngineConfiguration } from './state';
import { githubBuildClient, githubBuildRoot, readGithubDispatch } from './github';
import { enginePath } from './cloudflare';

export async function activeBuilds(org: string) {
  const store = getStore();
  const tasks = await store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 20 });
  return Promise.all(tasks.map(async task => {
    const input = await store.getDoc<BuildInput>(buildInputPath(org, task.id));
    const site = input?.kind === 'publication' ? await store.getDoc<{ name: string }>(paths.site(org, task.identity.site_id)) : null;
    return { key: task.id, site_id: task.identity.site_id, site_name: input?.kind === 'qualification' ? 'Build verification' : site?.name ?? task.identity.site_id,
      version_id: task.identity.version_id, status: task.status, provider: input?.provider ?? 'cloudflare', attempt: task.attempt };
  }));
}

export async function cancelGithubTask(org: string, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new ConnectionError('Invalid build task.', 400);
  const store = getStore(), task = await store.getDoc<BuildTask>(`${buildTasksPath(org)}/${key}`);
  const input = await store.getDoc<BuildInput>(buildInputPath(org, key));
  if (!task || input?.provider !== 'github') throw new ConnectionError('GitHub build not found.', 404);
  const config = await readEngineConfiguration(org, 'github');
  const cancelled = await new OrganizationBuildQueue().cancel(org, key);
  if (!cancelled) throw new ConnectionError('This build has already finished. Its publication cannot be cancelled here.', 409);
  if (input.kind === 'publication') await store.compareAndUpdateDoc<DeployJob>(paths.deploy(org, task.identity.site_id, task.identity.job_id), value => ['queued', 'running'].includes(value.status),
    { status: 'failed', phase: 'cancelled', error: 'The build was cancelled by an organization administrator.', finished_at: new Date().toISOString() });
  else if (config?.revision === task.engine_revision) {
    await store.compareAndUpdateDoc<EngineConfiguration>(engineConfigurationPath(org, 'github'), value => value.revision === task.engine_revision, { status: 'disabled' });
    await store.updateDoc(enginePath(org, 'github'), { revision: randomUUID(), enabled: false, state: 'setup_required', issue: { code: 'github_qualification_cancelled', message: 'Verification was cancelled. Finish build setup to try again.' } });
  }
  if (config?.revision !== task.engine_revision || !input.dispatch_nonce) return;
  try {
    const client = await githubBuildClient(config);
    const run = await readGithubDispatch(client, config, input);
    if (run && run.status !== 'completed') await client(`${githubBuildRoot(config)}/actions/runs/${run.id}/cancel`, { method: 'POST' });
  } catch { /* The revoked attempt cannot publish, even when GitHub cancellation is unavailable. */ }
}
