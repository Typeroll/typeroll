import { createHash, createSign } from 'node:crypto';

const GH = 'https://api.github.com';
const CF = 'https://api.cloudflare.com/client/v4';
export const PUBLICATION_BRANCH = /^main$|^version-[a-z0-9][a-z0-9-]{0,127}$/;

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export class ProviderError extends Error {
  constructor(provider, status, codes = []) {
    // Provider bodies can contain credentials or reflected request payloads.
    super(`${provider} request failed (HTTP ${status}); inspect access and resource status in the provider dashboard`);
    this.provider = provider;
    this.status = status;
    this.codes = codes.filter(code => Number.isSafeInteger(code));
  }
}

export function createProviderClient(provider, token, fetchImpl = fetch) {
  const base = provider === 'GitHub' ? GH : provider === 'Cloudflare' ? CF : null;
  if (!base || typeof token !== 'string' || !token) throw new Error('Missing provider credential');
  return async (route, { method = 'GET', body, missing = false } = {}) => {
    if (!route.startsWith('/') || route.startsWith('//') || /[\r\n]/.test(route)) {
      throw new Error('Invalid provider route');
    }
    let response;
    try {
      response = await fetchImpl(`${base}${route}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(provider === 'GitHub' ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}),
        },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`${provider} request did not complete; retry after checking resource status`);
    }
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      let codes = [];
      if (provider === 'Cloudflare') {
        try {
          const error = await response.json();
          if (Array.isArray(error.errors)) codes = error.errors.map(item => item?.code);
        } catch { /* Never include response bodies in errors. */ }
      }
      throw new ProviderError(provider, response.status, codes);
    }
    let data;
    try { data = await response.json(); } catch { throw new Error(`${provider} returned an invalid response`); }
    if (provider === 'Cloudflare') {
      if (data.success !== true) throw new ProviderError(provider, response.status);
      return data.result;
    }
    return data;
  };
}

export function githubAppClient({ appId, privateKey }, fetchImpl = fetch) {
  if (!/^\d+$/.test(String(appId)) || !privateKey) {
    throw new Error('GitHub App ID and private key are required');
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  let signature;
  try { signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url'); }
  catch { throw new Error('GitHub App private key is invalid'); }
  return createProviderClient('GitHub', `${unsigned}.${signature}`, fetchImpl);
}

export async function githubInstallationClient({ appId, installationId, privateKey, owner, accountId, accountType }, fetchImpl = fetch) {
  if (!/^\d+$/.test(String(installationId))) throw new Error('GitHub installation ID is required');
  const app = githubAppClient({ appId, privateKey }, fetchImpl);
  const installation = await app(`/app/installations/${installationId}`);
  assertInstallation(installation, { appId, installationId, owner, accountId, accountType });
  const access = await app(`/app/installations/${installationId}/access_tokens`, { method: 'POST', body: {} });
  return createProviderClient('GitHub', access.token, fetchImpl);
}

export function assertInstallation(installation, { appId, installationId, owner, accountId, accountType }) {
  if (String(installation.id) !== String(installationId) || String(installation.app_id) !== String(appId) ||
      installation.account?.login?.toLowerCase() !== owner.toLowerCase() ||
      (accountId !== undefined && String(installation.account?.id) !== String(accountId)) ||
      (accountType !== undefined && installation.account?.type !== accountType) ||
      !['Organization', 'User'].includes(installation.account?.type) || installation.suspended_at ||
      installation.repository_selection !== 'all' ||
      installation.permissions?.administration !== 'write' || installation.permissions?.contents !== 'write') {
    throw new Error('GitHub App must be active on the selected account with all-repository access and Administration/Contents write permissions');
  }
}

function repoRoute(owner, repo) {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(repo)) {
    throw new Error('Invalid repository identity');
  }
  return `/repos/${owner}/${repo}`;
}

/** Call only after verifying this is the integration's generated repository. */
export async function ensureGithubMainBranch(github, { owner, repo, repository }) {
  if (repository.default_branch === 'main') return repository;
  if (typeof repository.default_branch !== 'string' || !repository.default_branch) throw new Error('Generated repository has no default branch');
  const root = repoRoute(owner, repo);
  await github(`${root}/branches/${encodeURIComponent(repository.default_branch)}/rename`, { method: 'POST', body: { new_name: 'main' } });
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await github(root);
    if (current.id !== repository.id || String(current.owner?.id) !== String(repository.owner?.id) || current.private !== true) throw new Error('Generated repository identity changed');
    if (current.default_branch === 'main') return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('GitHub is still preparing the main branch. Retry setup or publishing shortly.');
}

/** Replace the entire generated tree while preserving history. Never force-push. */
export async function publishTree(github, { owner, repo, branch = 'main', files, message }) {
  if (!PUBLICATION_BRANCH.test(branch)) throw new Error('Invalid publication branch');
  const root = repoRoute(owner, repo);
  const treeEntries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!treeEntries.length || treeEntries.length > 10_000) throw new Error('Invalid publication file count');
  for (const [name, content] of treeEntries) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') ||
        typeof content !== 'string' || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid publication file');
  }
  let ref = await github(`${root}/git/ref/heads/${branch}`, { missing: true });
  if (!ref) {
    if (branch === 'main') throw new Error('Repository main branch must be initialized before publication');
    const main = await github(`${root}/git/ref/heads/main`);
    await github(`${root}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: main.object.sha } });
    ref = main;
  }
  const parent = await github(`${root}/git/commits/${ref.object.sha}`);
  const tree = await github(`${root}/git/trees`, {
    method: 'POST',
    // Deliberately omit base_tree: stale and manually added files disappear.
    body: { tree: treeEntries.map(([name, content]) => ({ path: name, mode: '100644', type: 'blob', content })) },
  });
  if (parent.tree.sha === tree.sha) return { commit: ref.object.sha, changed: false, branch };
  const commit = await github(`${root}/git/commits`, {
    method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] },
  });
  await github(`${root}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  return { commit: commit.sha, changed: true, branch };
}

export function pagesProjectBody({ owner, repo, repository, project }) {
  repoRoute(owner, repo);
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(project)) throw new Error('Invalid Pages project name');
  return {
    name: project,
    production_branch: 'main',
    build_config: { build_command: 'npm ci && npm run build', destination_dir: 'dist', root_dir: '/' },
    deployment_configs: Object.fromEntries(['production', 'preview'].map((environment) => [environment, {
      env_vars: { NODE_VERSION: { type: 'plain_text', value: '22.23.1' }, SKIP_DEPENDENCY_INSTALL: { type: 'plain_text', value: 'true' } },
    }])),
    source: { type: 'github', config: {
      owner, owner_id: String(repository.owner.id), repo_name: repo, repo_id: String(repository.id),
      production_branch: 'main', production_deployments_enabled: true,
      preview_deployment_setting: 'custom', preview_branch_includes: ['version-*'],
      preview_branch_excludes: [], pr_comments_enabled: false,
    } },
  };
}

export function assertPagesProject(actual, expected) {
  const a = actual.source?.config;
  const e = expected.source.config;
  const environmentMatches = ['production', 'preview'].every((environment) => {
    const variables = actual.deployment_configs?.[environment]?.env_vars;
    return variables && Object.keys(variables).sort().join(',') === 'NODE_VERSION,SKIP_DEPENDENCY_INSTALL' &&
      variables.NODE_VERSION?.type === 'plain_text' && variables.NODE_VERSION?.value === '22.23.1' &&
      variables.SKIP_DEPENDENCY_INSTALL?.type === 'plain_text' && variables.SKIP_DEPENDENCY_INSTALL?.value === 'true';
  });
  if (actual.name !== expected.name || actual.production_branch !== 'main' || actual.source?.type !== 'github' ||
      a?.owner?.toLowerCase() !== e.owner.toLowerCase() || String(a?.repo_id) !== e.repo_id ||
      a?.repo_name !== e.repo_name || a?.production_branch !== 'main' || a?.production_deployments_enabled !== true ||
      a?.preview_deployment_setting !== 'custom' || JSON.stringify(a?.preview_branch_includes) !== '["version-*"]' ||
      (a?.preview_branch_excludes?.length ?? 0) !== 0 ||
      actual.build_config?.build_command !== expected.build_config.build_command ||
      actual.build_config?.destination_dir !== 'dist' || !['', '/'].includes(actual.build_config?.root_dir ?? '') ||
      !environmentMatches || (actual.domains ?? []).some((domain) => domain !== `${expected.name}.pages.dev`) || actual.uses_functions === true) {
    throw new Error('Pages project does not match the isolated static Git publication plan');
  }
}

export function matchingDeployment(deployments, { project, commit, branch, ignoreSkipped = false }) {
  return deployments.find((deployment) => (!ignoreSkipped || !deployment.is_skipped) && deployment.project_name === project &&
    deployment.deployment_trigger?.metadata?.commit_hash === commit &&
    deployment.deployment_trigger?.metadata?.branch === branch &&
    deployment.environment === (branch === 'main' ? 'production' : 'preview')) ?? null;
}

/** Pages rejects a 100-item page. Search the same bounded history in valid batches. */
export async function findPublicationDeployment(provider, projectRoot, target) {
  for (let page = 1; page <= 4; page++) {
    const deployments = await provider(`${projectRoot}/deployments?per_page=25&page=${page}`);
    const match = matchingDeployment(deployments, target);
    if (match) return match;
    if (deployments.length < 25) return null;
  }
  return null;
}

export function assertSuccessfulStaticDeployment(deployment, project) {
  // The deployment API documents uses_functions as optional. When omitted,
  // require the project's explicit static flag AND its matching deployment
  // identity; an unrelated successful production build proves nothing about a preview.
  const projectMatches = Boolean(deployment.id && deployment.deployment_trigger?.metadata?.commit_hash && deployment.deployment_trigger?.metadata?.branch) && [project?.canonical_deployment, project?.latest_deployment].some(item =>
    item?.id === deployment.id && item?.deployment_trigger?.metadata?.commit_hash === deployment.deployment_trigger?.metadata?.commit_hash &&
    item?.deployment_trigger?.metadata?.branch === deployment.deployment_trigger?.metadata?.branch);
  const staticConfirmed = deployment.uses_functions === false ||
    (deployment.uses_functions == null && project?.uses_functions === false && projectMatches);
  if (deployment.is_skipped || !staticConfirmed ||
      deployment.latest_stage?.name !== 'deploy' || deployment.latest_stage?.status !== 'success') {
    throw new Error('Expected a completed static deployment without Functions');
  }
}

/** PATCH only the intended variable: round-tripping Pages config changes paired runtime settings. */
export async function setPagesBuildMediaAccess(provider, projectRoot, environment, access) {
  if (!['production', 'preview'].includes(environment)) throw new Error('Invalid Pages build environment');
  return provider(projectRoot, { method: 'PATCH', body: { deployment_configs: {
    [environment]: { env_vars: { TYPEROLL_BUILD_MEDIA_ACCESS: { type: 'secret_text', value: JSON.stringify(access) } } },
  } } });
}
