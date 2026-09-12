import { ensureGithubMainBranch } from '../publishing/providers.mjs';
import { createGithubRepository } from '../publishing/github-user';
import { randomBytes, randomUUID } from 'node:crypto';
import executorSource from './executor.mjs?raw';
import contractSource from './contract.mjs?raw';
import assetsSource from './assets.mjs?raw';
import { getStore } from '../datastore';
import { encryptSecret } from '../secret-crypto';
import { getConnection, ConnectionError } from '../publishing/connections';
import { cloudflareClient } from '../publishing/cloudflare-oauth';
import { githubConfiguration } from '../publishing/github-connection';
import { githubInstallationClient, publishTree, ProviderError } from '../publishing/providers.mjs';
import { readBuildEngine, checkBuildEngine, enginePath } from './cloudflare';
import { engineConfigurationPath, readEngineConfiguration, type EngineConfiguration } from './state';
import { OrganizationBuildQueue, buildTasksPath, buildTaskKey, type BuildTask } from './queue';
import { encodeSource, sha256, BUILD_PROTOCOL, BUILD_RUNTIME } from './contract.mjs';
import { prepareBuildRetention } from './storage';
import { qualificationSource } from './qualification';
import { enqueueBuild, completedBuild } from './jobs';

export async function configureBuildEngine(org: string, input: Record<string, unknown>) {
  if (!input.action || input.action === 'check') {
    const config = await readEngineConfiguration(org);
    if (config?.status === 'qualifying' && config.qualification_key) {
      try { await completedBuild(org, config.qualification_key); }
      catch (error) { if (error instanceof ConnectionError) {
        await new OrganizationBuildQueue().cancel(org, config.qualification_key);
        await getStore().compareAndUpdateDoc<EngineConfiguration>(engineConfigurationPath(org), value => value.revision === config.revision, { status: 'disabled' });
        await getStore().updateDoc(enginePath(org), { state: 'error', enabled: false, issue: { code: error.code ?? 'build_verification_failed', message: error.message } });
      } else throw error; }
      return readBuildEngine(org);
    }
    return checkBuildEngine(org, input);
  }
  if (input.action !== 'setup') throw new ConnectionError('Unknown build setup action.', 400);
  let current = await readBuildEngine(org);
  if (input.revision !== current.revision) throw new ConnectionError('Build settings changed. Check again.', 409);
  const store = getStore(), path = engineConfigurationPath(org);
  const previous = await readEngineConfiguration(org);
  if (previous?.status === 'qualifying') return configureBuildEngine(org, { action: 'check', revision: current.revision });
  if ((previous?.setup_lease_until ?? 0) > Date.now()) throw new ConnectionError('Shared build setup is already running.', 409);
  const pending = await store.listDocs<BuildTask>(buildTasksPath(org), { filters: [{ field: 'status', op: 'in', value: ['queued', 'running'] }], limit: 1 });
  if (pending.length) throw new ConnectionError('Wait for current builds to finish before updating the engine.', 409);
  const [cf, git] = await Promise.all([getConnection(org, 'cloudflare'), getConnection(org, 'github')]);
  if (cf.status !== 'connected' || !cf.cloudflare || git.status !== 'connected' || !git.github) throw new ConnectionError('Connect GitHub and the organization Cloudflare account first.', 409);
  // Check the customer grant before creating resources or changing storage retention.
  current = await checkBuildEngine(org, { revision: current.revision });
  if (current.state === 'approval_required' || current.state === 'error') return current;
  const origin = new URL(process.env.PORTAL_PUBLIC_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new ConnectionError('Shared builds require the public HTTPS address of this Typeroll server.', 409);
  const revision = randomUUID(), token = randomBytes(32).toString('base64url');
  let config: EngineConfiguration = { revision, account_id: cf.cloudflare.account_id, owner: git.github.owner, installation_id: git.github.installation_id,
    worker_tag: '', trigger_uuid: '', runner_commit: '', token_hash: sha256(token), encrypted_token: encryptSecret(JSON.stringify({ org, token })),
    status: 'preparing', setup_lease_until: Date.now() + 180000 };
  if (previous) {
    if (!await store.compareAndUpdateDoc<EngineConfiguration>(path, value => value.revision === previous.revision && value.setup_lease_until <= Date.now(), config)) throw new ConnectionError('Build settings changed. Try again.', 409);
  } else if (!await store.createDocIfMissing(path, config)) throw new ConnectionError('Build setup has already started.', 409);
  let phase: 'R2 build storage' | 'Workers Scripts' | 'GitHub repository' | 'Workers Builds' = 'R2 build storage';
  try {
    await store.createDocIfMissing(enginePath(org), current);
    await store.updateDoc(enginePath(org), { enabled: false, state: 'setup_required', issue: { code: 'build_preparing', message: 'Preparing the shared build engine…' } });
    await prepareBuildRetention(org);
    phase = 'Workers Scripts';
    const client = await cloudflareClient(org), base = `/accounts/${config.account_id}`;
    const name = current.worker_name, tag = `typeroll-build-${sha256(org).slice(0, 16)}`;
    let worker = (await client(`${base}/workers/scripts`)).find((entry: any) => entry.id === name);
    // The earlier explicitly provisioned staging pilot has the same deterministic name.
    if (worker && !worker.tags?.includes(tag) && !worker.tags?.includes('typeroll-staging-build-qualification')) throw new ConnectionError('A different Worker already uses the generated build project name.', 409);
    if (!worker) {
      const body = new FormData();
      body.append('metadata', JSON.stringify({ main_module: 'anchor.mjs', compatibility_date: '2026-09-09', tags: [tag], bindings: [] }));
      body.append('anchor.mjs', new Blob(['export default { fetch() { return new Response(null, {status:404}); } };\n'], { type: 'application/javascript+module' }), 'anchor.mjs');
      worker = await client(`${base}/workers/scripts/${name}`, { method: 'PUT', body });
    }
    await client(`${base}/workers/scripts/${name}/subdomain`, { method: 'POST', body: { enabled: false, previews_enabled: false } });
    const exposure = await client(`${base}/workers/scripts/${name}/subdomain`);
    if (exposure.enabled || exposure.previews_enabled) throw new ConnectionError('Cloudflare did not disable the build project’s public URLs.', 502);
    config.worker_tag = worker.tag;
    phase = 'GitHub repository';
    const ghConfig = githubConfiguration();
    const github = await githubInstallationClient({ ...ghConfig, installationId: config.installation_id, owner: config.owner });
    const repoPath = `/repos/${config.owner}/${current.runner_repo}`;
    const description = `Generated Typeroll organization build engine ${sha256(org).slice(0, 16)}`;
    let repo = await github(repoPath, { missing: true });
    if (!repo) repo = await createGithubRepository(org, github, git.github, { name: current.runner_repo, private: true, auto_init: true, description, has_issues: false, has_projects: false, has_wiki: false });
    const pilot = repo.description === 'Typeroll staging organization build qualification. Generated source only; not an active site publisher.' && worker.tags?.includes('typeroll-staging-build-qualification');
    if (!repo.private || repo.owner?.login !== config.owner || repo.archived || (repo.description !== description && !pilot)) throw new ConnectionError('The generated build repository belongs to another integration.', 409);
    repo = await ensureGithubMainBranch(github, { owner: config.owner, repo: current.runner_repo, repository: repo });
    if (pilot) await github(repoPath, { method: 'PATCH', body: { description } });
    phase = 'Workers Builds';
    const triggers = await client(`${base}/builds/workers/${config.worker_tag}/triggers`);
    for (const trigger of triggers) await client(`${base}/builds/triggers/${trigger.trigger_uuid}`, { method: 'PATCH', body: { path_excludes: ['*'] } });
    phase = 'GitHub repository';
    const runner = await publishTree(github, { owner: config.owner, repo: current.runner_repo,
      files: { 'assets.mjs': assetsSource, 'executor.mjs': executorSource, 'contract.mjs': contractSource, 'engine.json': JSON.stringify({ origin: origin.origin, org_id: org, revision }),
        '.node-version': BUILD_RUNTIME + '\n', 'package.json': JSON.stringify({ name, private: true, type: 'module', scripts: { build: 'node executor.mjs', 'qualify:artifact': 'node finalize.mjs' } }),
        'finalize.mjs': "console.log('Typeroll build attempt finished. Static hosting is handled by the publication coordinator.');\n",
        'README.md': '# Typeroll shared builds\n\nGenerated source only. One runner for this organization. Site repositories and version branches remain separate. Public Worker URLs are disabled. Builds are dispatched explicitly by Typeroll.\n' },
      message: 'Update the organization static build executor' });
    config.runner_commit = runner.commit;
    phase = 'Workers Builds';
    const tokens = await client(`${base}/builds/tokens`);
    let trigger = triggers.find((entry: any) => entry.branch_includes?.includes('main') && !entry.branch_excludes?.includes('main'));
    const tokenId = trigger?.build_token_uuid ?? (tokens.length === 1 ? tokens[0].build_token_uuid : null);
    if (!tokenId) {
      await store.updateDoc(enginePath(org), { revision: randomUUID(), state: 'build_token_required', worker_found: true, account_id: config.account_id, account_name: cf.cloudflare.account_name, enabled: false,
        issue: { code: tokens.length > 1 ? 'build_token_selection_required' : 'build_token_required', message: 'The build project is prepared. Open Cloudflare setup, connect the generated GitHub repository on branch main and create or select its API token. Then return and finish build setup.' } });
      await store.updateDoc(path, { ...config, status: 'disabled', setup_lease_until: 0 });
      return readBuildEngine(org);
    }
    const connection = await client(`${base}/builds/repos/connections`, { method: 'PUT', body: { provider_type: 'github', provider_account_id: String(repo.owner.id), provider_account_name: config.owner, repo_id: String(repo.id), repo_name: current.runner_repo } });
    const triggerBody = { branch_includes: ['main'], branch_excludes: [], path_includes: ['*'], path_excludes: ['*'], build_command: 'npm run build', deploy_command: 'npm run qualify:artifact', root_directory: '/', build_token_uuid: tokenId, build_caching_enabled: false, trigger_name: 'Typeroll shared builds' };
    if (trigger) {
      if (trigger.repo_connection?.repo_id && String(trigger.repo_connection.repo_id) !== String(repo.id)) throw new ConnectionError('The Worker is connected to a different repository.', 409);
      trigger = await client(`${base}/builds/triggers/${trigger.trigger_uuid}`, { method: 'PATCH', body: triggerBody });
    } else trigger = await client(`${base}/builds/triggers`, { method: 'POST', body: { ...triggerBody, external_script_id: config.worker_tag, repo_connection_uuid: connection.repo_connection_uuid } });
    config.trigger_uuid = trigger.trigger_uuid;
    await client(`${base}/builds/triggers/${config.trigger_uuid}/environment_variables`, { method: 'PATCH', body: { TYPEROLL_RUNNER_TOKEN: { value: token, is_secret: true }, SKIP_DEPENDENCY_INSTALL: { value: '1', is_secret: false } } });
    const publicationId = sha256(`qualification:${org}:${revision}`), source = qualificationSource(publicationId);
    const identity = { org_id: org, site_id: 'engine-qualification', version_id: 'main', job_id: revision, publication_id: publicationId, commit: config.runner_commit, branch: 'main' };
    config = { ...config, status: 'qualifying', setup_lease_until: 0, qualification_key: buildTaskKey({ ...identity, protocol: BUILD_PROTOCOL, node_version: BUILD_RUNTIME, source_sha256: sha256(encodeSource(source)) }) };
    await store.updateDoc(path, config);
    await store.updateDoc(enginePath(org), { revision: randomUUID(), state: 'qualification_required', enabled: false, worker_found: true, account_id: config.account_id, account_name: cf.cloudflare.account_name,
      issue: { code: 'build_verification_running', message: 'Verifying isolated execution and artifact transfer. This page updates automatically when the check finishes.' } });
    await enqueueBuild(config, identity, source, 'qualification');
    return readBuildEngine(org);
  } catch (error) {
    if (config.qualification_key) await new OrganizationBuildQueue().cancel(org, config.qualification_key);
    await store.compareAndUpdateDoc<EngineConfiguration>(path, value => value.revision === config.revision, { status: 'disabled', setup_lease_until: 0 });
    if (error instanceof ProviderError) {
      const buildPermission = error.provider === 'Cloudflare' && ['Workers Scripts', 'Workers Builds'].includes(phase) && [401, 403].includes(error.status);
      const detail = `HTTP ${error.status}${error.codes.length ? `, code ${error.codes.join(', ')}` : ''}`;
      await store.updateDoc(enginePath(org), { revision: randomUUID(), state: buildPermission ? 'approval_required' : 'error', enabled: false,
        issue: { code: buildPermission ? 'build_permission_required' : 'build_setup_failed', http_status: error.status, provider_codes: error.codes,
          message: buildPermission
            ? `Cloudflare denied changes to ${phase} in ${cf.cloudflare.account_name} (${detail}). Click Approve build permissions, approve access in Cloudflare, then return and finish build setup. Your hosting and media connections stay connected.`
            : `Build setup stopped at ${phase} (${detail}). Check ${phase === 'R2 build storage' ? 'Media storage and the organization Cloudflare connection' : phase === 'GitHub repository' ? 'the GitHub connection and repository permissions' : 'the organization Cloudflare connection'}, then retry setup.` } });
      return readBuildEngine(org);
    }
    await store.updateDoc(enginePath(org), { revision: randomUUID(), state: 'error', enabled: false, issue: { code: 'build_setup_failed', message: error instanceof ConnectionError ? error.message : 'Shared build setup could not finish. Retry setup after checking the organization connections.' } });
    throw error;
  }
}
