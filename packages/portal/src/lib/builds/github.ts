import { randomUUID } from 'node:crypto';
import { getStore } from '../datastore';
import { ConnectionError, getConnection } from '../publishing/connections';
import { checkGithubPermissions } from '../publishing/github-permissions';
import { githubConfiguration } from '../publishing/github-connection';
import { githubAppClient, githubInstallationClient, publishTree, digest, ProviderError, type ProviderClient } from '../publishing/providers.mjs';
import { enginePath, type BuildEngine } from './cloudflare';
import { engineConfigurationPath, readEngineConfiguration, assertEngineConnections, type EngineConfiguration, type BuildInput } from './state';
import { buildTasksPath, buildTaskKey, type BuildTask } from './queue';
import { BUILD_PROTOCOL, BUILD_RUNTIME, encodeSource, sha256 } from './contract.mjs';
import { qualificationSource } from './qualification';
import { prepareBuildRetention } from './storage';
import { githubBuildFiles } from './github-source';

export async function readGithubEngine(org: string): Promise<BuildEngine> {
  return await getStore().getDoc<BuildEngine>(enginePath(org, 'github')) ?? {
    provider: 'github', revision: 'initial', state: 'not_configured', enabled: false, account_id: null, account_name: null,
    worker_name: '', runner_repo: `typeroll-github-builder-${digest(org).slice(0, 16)}`, checked_at: null, issue: null,
    protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME,
  };
}

export async function githubBuildClient(config: EngineConfiguration) {
  return githubInstallationClient({ ...githubConfiguration(), owner: config.owner, installationId: config.installation_id });
}
export function githubBuildRoot(config: EngineConfiguration) {
  if (!config.github || !/^[a-z0-9-]{1,39}$/i.test(config.owner) || !/^[a-z0-9-]{1,100}$/.test(config.github.repo)) throw new ConnectionError('GitHub build configuration is invalid.', 409);
  return `/repos/${config.owner}/${config.github.repo}`;
}

/** Provider metadata independently binds the run to the dispatch, App and immutable runner. */
export function assertGithubRun(run: any, config: EngineConfiguration, nonce: string, expectedId?: string) {
  const github = config.github;
  if (!github || !/^[a-f0-9-]{36}$/.test(nonce) || !Number.isSafeInteger(run?.id) || (expectedId && String(run.id) !== expectedId) ||
      String(run.repository?.id) !== github.repository_id || String(run.repository?.owner?.id) !== github.owner_id ||
      run.path !== '.github/workflows/build.yml' || run.event !== 'workflow_dispatch' || run.head_sha !== config.runner_commit ||
      run.head_branch !== 'main' || run.run_attempt !== 1 || run.actor?.login !== github.app_bot ||
      run.triggering_actor?.id !== run.actor?.id || run.display_title !== `Typeroll build ${nonce}`) {
    throw new ConnectionError('The GitHub run does not match this build attempt.', 409, 'github_build_run_mismatch');
  }
}

export async function dispatchGithubBuild(client: ProviderClient, config: EngineConfiguration, key: string, nonce: string) {
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9-]{36}$/.test(nonce)) throw new ConnectionError('Invalid build dispatch.', 400);
  const root = githubBuildRoot(config);
  let ref, workflow;
  try {
    ref = await client(`${root}/git/ref/heads/main`);
    workflow = await client(`${root}/actions/workflows/${config.github!.workflow_id}`);
  } catch (error) {
    throw new ConnectionError(`GitHub build setup could not be read${error instanceof ProviderError ? ` (HTTP ${error.status})` : ''}. Check repository Actions access in Publishing → Builds.`, 502, 'github_runner_unavailable');
  }
  if (ref.object?.sha !== config.runner_commit) throw new ConnectionError('The generated GitHub runner was changed. Update it in Publishing → Builds.', 409, 'github_runner_changed');
  if (workflow.state !== 'active' || workflow.path !== '.github/workflows/build.yml') throw new ConnectionError('Enable Actions for the generated build repository, then retry.', 409, 'github_workflow_disabled');
  let response;
  try {
    response = await client(`${root}/actions/workflows/${workflow.id}/dispatches`, {
      method: 'POST', body: { ref: 'main', inputs: { task_key: key, dispatch_nonce: nonce } },
    });
  } catch (error) {
    if (error instanceof ProviderError && error.status >= 400 && error.status < 500 && error.status !== 408)
      throw new ConnectionError(`GitHub rejected the build request (HTTP ${error.status}). Check Actions access and build allowances in the connected GitHub account, then retry.`, 502, 'github_dispatch_rejected');
    throw error;
  }
  if (!Number.isSafeInteger(response?.workflow_run_id)) throw new ConnectionError('GitHub did not return the build identity. Typeroll will check its history before retrying.', 502, 'github_dispatch_uncertain');
  return String(response.workflow_run_id);
}

export async function readGithubDispatch(client: ProviderClient, config: EngineConfiguration, input: BuildInput) {
  const root = githubBuildRoot(config);
  if (input.dispatch_id) {
    const run = await client(`${root}/actions/runs/${input.dispatch_id}`);
    assertGithubRun(run, config, input.dispatch_nonce!, input.dispatch_id); return run;
  }
  const history = await client(`${root}/actions/workflows/${config.github!.workflow_id}/runs?event=workflow_dispatch&per_page=100`);
  const runs = history.workflow_runs.filter((run: any) => run.display_title === `Typeroll build ${input.dispatch_nonce}`);
  if (runs.length !== 1) return null; // Missing or ambiguous history cannot authorize another dispatch.
  const run = await client(`${root}/actions/runs/${runs[0].id}`);
  assertGithubRun(run, config, input.dispatch_nonce!); return run;
}

export async function configureGithubEngine(org: string, input: Record<string, unknown>) {
  const current = await readGithubEngine(org), previous = await readEngineConfiguration(org, 'github');
  if (input.revision !== current.revision) throw new ConnectionError('Build settings changed. Check again.', 409, 'build_settings_changed');
  if (input.action && !['check', 'setup'].includes(String(input.action))) throw new ConnectionError('Unknown GitHub build action.', 400);
  if (previous?.status === 'qualifying') {
    try { await (await import('./jobs')).completedBuild(org, previous.qualification_key!); }
    catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      await getStore().compareAndUpdateDoc<EngineConfiguration>(engineConfigurationPath(org, 'github'), value => value.revision === previous.revision && value.status === 'qualifying', { status: 'disabled' });
      await getStore().updateDoc(enginePath(org, 'github'), { revision: randomUUID(), state: 'error', enabled: false, issue: { code: error.code ?? 'github_qualification_failed', message: error.message } });
    }
    return readGithubEngine(org);
  }
  const connection = await getConnection(org, 'github');
  if (connection.status !== 'connected' || !connection.github) throw new ConnectionError('Connect GitHub in Publishing first.', 409, 'github_connection_required');
  const permissions = await checkGithubPermissions(org);
  const next: BuildEngine = { ...current, revision: randomUUID(), account_id: connection.github.account_id, account_name: connection.github.owner,
    checked_at: new Date().toISOString(), state: permissions.state === 'up_to_date' ? 'setup_required' : 'approval_required', enabled: false,
    issue: permissions.state === 'up_to_date' ? null : { code: 'github_build_permissions_required', message: permissions.message } };
  const store = getStore(), path = engineConfigurationPath(org, 'github');
  if (permissions.state !== 'up_to_date' || input.action !== 'setup') {
    if (permissions.state === 'up_to_date' && previous?.status === 'ready') {
      await assertEngineConnections(org, previous);
      const client = await githubBuildClient(previous), ref = await client(`${githubBuildRoot(previous)}/git/ref/heads/main`);
      const workflow = await client(`${githubBuildRoot(previous)}/actions/workflows/${previous.github!.workflow_id}`);
      if (workflow.state !== 'active' || workflow.path !== '.github/workflows/build.yml') next.issue = { code: 'github_workflow_disabled', message: 'Enable Actions for the generated build repository, then check again.' };
      else if (ref.object?.sha === previous.runner_commit) { next.state = 'ready'; next.enabled = true; }
      else next.issue = { code: 'github_runner_changed', message: 'The generated runner changed. Update the GitHub build engine before publishing.' };
    }
    await store.createDocIfMissing(enginePath(org, 'github'), current);
    if (!await store.compareAndUpdateDoc<BuildEngine>(enginePath(org, 'github'), value => value.revision === current.revision, next)) throw new ConnectionError('Build settings changed. Check again.', 409);
    return next;
  }
  const cf = await getConnection(org, 'cloudflare');
  if (cf.status !== 'connected' || !cf.cloudflare) throw new ConnectionError('Connect the organization Cloudflare account and prepare Media storage first.', 409);
  const origin = new URL(process.env.PORTAL_PUBLIC_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new ConnectionError('GitHub builds require this Typeroll server’s public HTTPS address.', 409);
  if ((previous?.setup_lease_until ?? 0) > Date.now()) throw new ConnectionError('GitHub setup is already running.', 409);
  const pending = await store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 100 });
  if (previous && pending.some(task => task.engine_revision === previous.revision)) throw new ConnectionError('Wait for current GitHub builds to finish before updating this engine.', 409);
  const revision = randomUUID();
  let config: EngineConfiguration = { provider: 'github', revision, owner: connection.github.owner, installation_id: connection.github.installation_id,
    account_id: cf.cloudflare.account_id, worker_tag: '', trigger_uuid: '', runner_commit: '', token_hash: '', encrypted_token: '', status: 'preparing', setup_lease_until: Date.now() + 180000 };
  if (previous) {
    if (!await store.compareAndUpdateDoc<EngineConfiguration>(path, value => value.revision === previous.revision && value.setup_lease_until <= Date.now(), config)) throw new ConnectionError('GitHub build settings changed.', 409);
  } else if (!await store.createDocIfMissing(path, config)) throw new ConnectionError('GitHub setup already started.', 409);
  try {
    await store.createDocIfMissing(enginePath(org, 'github'), current);
    await store.updateDoc(enginePath(org, 'github'), { ...next, state: 'setup_required', issue: { code: 'build_preparing', message: 'Preparing the GitHub build engine…' } });
    await prepareBuildRetention(org);
    const app = await githubAppClient(githubConfiguration())('/app');
    if (!/^[a-z0-9-]+$/.test(app.slug)) throw new ConnectionError('The publisher App identity is invalid.', 409);
    const client = await githubBuildClient(config), root = `/repos/${config.owner}/${current.runner_repo}`;
    const description = `Generated Typeroll GitHub build engine ${digest(org).slice(0, 16)}`;
    let repo = await client(root, { missing: true });
    if (!repo) repo = await client(`/orgs/${config.owner}/repos`, { method: 'POST', body: { name: current.runner_repo, private: true, auto_init: true, description, has_issues: false, has_projects: false, has_wiki: false } });
    if (!repo.private || repo.archived || repo.default_branch !== 'main' || String(repo.owner?.id) !== connection.github.account_id || repo.description !== description) throw new ConnectionError('The generated GitHub build repository belongs to another integration.', 409);
    const published = await publishTree(client, { owner: config.owner, repo: current.runner_repo, files: githubBuildFiles(origin.origin, org, revision), message: 'Update the organization GitHub build executor' });
    let workflow;
    for (let attempt = 0; attempt < 6; attempt++) {
      workflow = await client(`${root}/actions/workflows/build.yml`, { missing: true });
      if (workflow) break;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
    if (!workflow || workflow.state !== 'active' || workflow.path !== '.github/workflows/build.yml' || !Number.isSafeInteger(workflow.id)) throw new ConnectionError('GitHub has not enabled the generated workflow yet. Check Actions access and retry setup.', 409, 'github_workflow_pending');
    config.runner_commit = published.commit;
    config.github = { repository_id: String(repo.id), owner_id: String(repo.owner.id), repo: current.runner_repo, app_bot: `${app.slug}[bot]`, workflow_id: workflow.id };
    await assertEngineConnections(org, config);
    const publicationId = sha256(`github-qualification:${org}:${revision}`), source = qualificationSource(publicationId);
    const identity = { org_id: org, site_id: 'engine-qualification', version_id: 'main', job_id: revision, publication_id: publicationId, commit: config.runner_commit, branch: 'main' };
    config = { ...config, status: 'qualifying', setup_lease_until: 0, qualification_key: buildTaskKey({ ...identity, protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME, source_sha256: sha256(encodeSource(source)) }) };
    await store.updateDoc(path, config);
    await store.updateDoc(enginePath(org, 'github'), { revision: randomUUID(), state: 'qualification_required', enabled: false, issue: { code: 'build_verification_running', message: 'Verifying GitHub identity, isolated execution and media-storage transfer. This page updates automatically.' } });
    await (await import('./jobs')).enqueueBuild(config, identity, source, 'qualification');
    return readGithubEngine(org);
  } catch (error) {
    if (config.qualification_key) await new (await import('./queue')).OrganizationBuildQueue().cancel(org, config.qualification_key);
    await store.compareAndUpdateDoc<EngineConfiguration>(path, value => value.revision === revision, { status: 'disabled', setup_lease_until: 0 });
    await store.updateDoc(enginePath(org, 'github'), { revision: randomUUID(), state: 'error', enabled: false, issue: { code: 'github_build_setup_failed', message: error instanceof ConnectionError ? error.message : 'GitHub setup could not finish. Check the organization connections and retry.' } });
    throw error;
  }
}
