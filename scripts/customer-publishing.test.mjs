import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  digest, createProviderClient, assertInstallation, publishTree, pagesProjectBody,
  assertPagesProject, matchingDeployment, findPublicationDeployment, assertSuccessfulStaticDeployment,
} from './lib/customer-publishing.mjs';
import {
  buildPublishingProbePlan, probePublicationFiles, prepareProbeDirectory,
  observeProbeDeployment, ensureProbeResources, runPublishingProbe,
} from './lib/customer-publishing-probe.mjs';

const config = {
  github_owner: 'synthetic-agency', cloudflare_account_id: 'a'.repeat(32),
  github_app_id: '12', github_installation_id: '34', prefix: 'tr-probe-synthetic', media_bucket: 'synthetic-media',
};
const plan = buildPublishingProbePlan(config);

test('probe plans bind exact resources and reject credentials or unsafe identities', () => {
  assert.equal(plan.repositories.length, 3);
  assert.deepEqual(plan.repositories, ['tr-probe-synthetic-01', 'tr-probe-synthetic-02', 'tr-probe-synthetic-03']);
  assert.deepEqual(plan.branches, ['main', 'version-next']);
  assert.equal(buildPublishingProbePlan({ ...config }).fingerprint, plan.fingerprint);
  assert.notEqual(buildPublishingProbePlan({ ...config, media_bucket: 'different-media' }).fingerprint, plan.fingerprint);
  assert.throws(() => buildPublishingProbePlan({ ...config, token: 'never-export' }), /Unexpected/);
  for (const mutation of [{ prefix: 'customer-production' }, { github_owner: '../other' }, { media_bucket: 'bad/bucket' }, { cloudflare_account_id: '' }]) {
    assert.throws(() => buildPublishingProbePlan({ ...config, ...mutation }), /Invalid/);
  }
});

test('installation preflight requires reusable organization access, not a personal token', () => {
  const installation = {
    id: 34, app_id: 12, account: { login: 'synthetic-agency', type: 'Organization' },
    repository_selection: 'all', suspended_at: null, permissions: { administration: 'write', contents: 'write' },
  };
  const expected = { appId: '12', installationId: '34', owner: 'synthetic-agency' };
  assert.doesNotThrow(() => assertInstallation(installation, expected));
  for (const mutation of [
    { repository_selection: 'selected' }, { suspended_at: '2026-01-01' }, { app_id: 99 },
    { account: { login: 'other-agency', type: 'Organization' } }, { permissions: { contents: 'read' } },
  ]) assert.throws(() => assertInstallation({ ...installation, ...mutation }, expected), /GitHub App/);
});

test('provider errors never surface reflected secrets and redirects cannot carry credentials elsewhere', async () => {
  const secret = 'synthetic-credential-must-not-escape';
  const github = createProviderClient('GitHub', secret, async (url, request) => {
    assert.equal(url, 'https://api.github.com/test');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Bearer ${secret}`);
    return new Response(JSON.stringify({ message: secret }), { status: 403 });
  });
  await assert.rejects(github('/test'), (error) => !error.message.includes(secret) && error.status === 403);
  await assert.rejects(github('//elsewhere'), /Invalid provider route/);
  const cloudflare = createProviderClient('Cloudflare', secret, async () => new Response(JSON.stringify({ success: false, errors: [{ message: secret }] })));
  await assert.rejects(cloudflare('/test'), (error) => !error.message.includes(secret));
});

async function localGitApi(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-git-publication-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', input,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  git(['init', '-b', 'main']);
  git(['commit', '--allow-empty', '-m', 'Initialize synthetic repository']);
  const requests = [];
  const api = async (route, options = {}) => {
    requests.push({ route, ...options });
    const endpoint = route.replace(/^\/repos\/synthetic-agency\/generated-site/, '');
    if (endpoint.startsWith('/git/ref/heads/')) {
      try { return { object: { sha: git(['rev-parse', '--verify', `refs/heads/${endpoint.slice(15)}`]) } }; }
      catch { if (options.missing) return null; throw new Error('Missing ref'); }
    }
    if (endpoint.startsWith('/git/commits/')) return { tree: { sha: git(['rev-parse', `${endpoint.slice(13)}^{tree}`]) } };
    if (endpoint === '/git/trees') {
      // Construct real Git objects, independently of the publisher's tree API.
      git(['read-tree', '--empty']);
      for (const entry of options.body.tree) {
        const blob = git(['hash-object', '-w', '--stdin'], entry.content);
        git(['update-index', '--add', '--cacheinfo', '100644', blob, entry.path]);
      }
      return { sha: git(['write-tree']) };
    }
    if (endpoint === '/git/commits') return { sha: git(['commit-tree', options.body.tree, '-p', options.body.parents[0], '-m', options.body.message]) };
    if (endpoint === '/git/refs') { git(['update-ref', options.body.ref, options.body.sha]); return {}; }
    if (endpoint.startsWith('/git/refs/heads/')) {
      assert.equal(options.body.force, false);
      const ref = `refs/heads/${endpoint.slice(16)}`;
      git(['merge-base', '--is-ancestor', ref, options.body.sha]);
      git(['update-ref', ref, options.body.sha]);
      return {};
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  return { git, api, requests };
}

test('real Git trees remove stray files, preserve history, skip no-ops and isolate version branches', async (t) => {
  const { git, api, requests } = await localGitApi(t);
  const args = { owner: 'synthetic-agency', repo: 'generated-site', message: 'Publish synthetic content' };
  const first = await publishTree(api, { ...args, files: { 'page.json': '{"title":"First"}', 'stale.txt': 'removed later' } });
  const second = await publishTree(api, { ...args, files: { 'page.json': '{"title":"Second"}', 'nested/source.astro': '<h1>Source</h1>' } });
  assert.equal(second.changed, true);
  assert.equal(git(['rev-parse', `${second.commit}^`]), first.commit);
  assert.deepEqual(git(['ls-tree', '-r', '--name-only', 'main']).split('\n'), ['nested/source.astro', 'page.json']);
  assert.ok(requests.filter((request) => request.route.endsWith('/git/trees')).every((request) => !('base_tree' in request.body)));
  const again = await publishTree(api, { ...args, files: { 'nested/source.astro': '<h1>Source</h1>', 'page.json': '{"title":"Second"}' } });
  assert.equal(again.commit, second.commit);
  assert.equal(again.changed, false);
  const preview = await publishTree(api, { ...args, branch: 'version-next', files: { 'page.json': '{"title":"Preview"}' } });
  assert.equal(git(['rev-parse', 'main']), second.commit);
  assert.equal(git(['rev-parse', `${preview.commit}^`]), second.commit);
  assert.equal(git(['show', 'version-next:page.json']), '{"title":"Preview"}');
  await assert.rejects(publishTree(api, { ...args, branch: '../main', files: { 'file': 'value' } }), /branch/);
  await assert.rejects(publishTree(api, { ...args, files: { '../outside': 'value' } }), /file/);
});

test('probe output is complete synthetic source, pinned and distinct per version', async (t) => {
  const files = await probePublicationFiles(plan, plan.repositories[0]);
  const next = await probePublicationFiles(plan, plan.repositories[0], 'next');
  assert.equal(JSON.parse(files['publication.json']).pages.length, 50);
  assert.equal(JSON.parse(files['package.json']).dependencies.astro, '7.2.10');
  assert.equal(JSON.parse(files['package-lock.json']).lockfileVersion, 3);
  assert.notEqual(files['publication.json'], next['publication.json']);
  assert.notEqual(files['publication-manifest.json'], next['publication-manifest.json']);
  assert.ok(!Object.keys(files).some((file) => /worker|functions|\.env|^dist\//.test(file)));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-probe-prepare-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const target = path.join(tmp, 'prepared');
  await prepareProbeDirectory(plan, target);
  assert.equal(await fs.readFile(path.join(target, plan.repositories[2], 'publication.json'), 'utf8'), (await probePublicationFiles(plan, plan.repositories[2]))['publication.json']);
  await assert.rejects(prepareProbeDirectory(plan, target), { code: 'EEXIST' });
});

test('Pages validation rejects another repo, dynamic execution, custom domains and wrong build settings', () => {
  const expected = pagesProjectBody({ owner: config.github_owner, repo: plan.repositories[0], project: plan.repositories[0], repository: { id: 17, owner: { id: 18 } } });
  assert.doesNotThrow(() => assertPagesProject(expected, expected));
  for (const actual of [
    { ...expected, uses_functions: true }, { ...expected, domains: ['customer.example'] },
    { ...expected, deployment_configs: {} },
    { ...expected, build_config: { ...expected.build_config, destination_dir: 'other' } },
    { ...expected, source: { type: 'github', config: { ...expected.source.config, repo_id: '99' } } },
    { ...expected, source: { type: 'github', config: { ...expected.source.config, preview_deployment_setting: 'all' } } },
  ]) assert.throws(() => assertPagesProject(actual, expected), /does not match/);
});

test('existing unrelated repositories are never adopted or changed', async () => {
  const calls = [];
  await assert.rejects(ensureProbeResources(plan, plan.repositories[0], {
    github: async (route, options = {}) => { calls.push(options.method ?? 'GET'); return { name: plan.repositories[0], private: true, owner: { login: config.github_owner }, description: 'Unrelated customer data' }; },
    cloudflare: async () => { throw new Error('Must not reach Cloudflare'); },
  }), /does not belong/);
  assert.deepEqual(calls, ['GET']);
});

function deployment(overrides = {}) {
  return {
    id: 'deployment-one', project_name: plan.repositories[0],
    deployment_trigger: { metadata: { commit_hash: 'commit-one', branch: 'main' } },
    environment: 'production', uses_functions: false,
    latest_stage: { name: 'deploy', status: 'success' },
    url: `https://12345678.${plan.repositories[0]}.pages.dev`,
    ...overrides,
  };
}

test('deployment success requires the exact commit, project, branch and completed static deploy', () => {
  const expected = { project: plan.repositories[0], commit: 'commit-one', branch: 'main' };
  assert.equal(matchingDeployment([deployment({ project_name: 'wrong' }), deployment()], expected).id, 'deployment-one');
  assert.equal(matchingDeployment([deployment({ environment: 'preview' })], expected), null);
  assert.doesNotThrow(() => assertSuccessfulStaticDeployment(deployment()));
  for (const variant of [{ uses_functions: true }, { uses_functions: undefined }, { is_skipped: true }, { latest_stage: { name: 'build', status: 'success' } }]) {
    assert.throws(() => assertSuccessfulStaticDeployment(deployment(variant)), /completed static/);
  }
});

test('an omitted deployment static flag requires explicit project proof for the same deployment', () => {
  const actual = deployment({ uses_functions: undefined });
  assert.doesNotThrow(() => assertSuccessfulStaticDeployment(actual, { uses_functions: false, canonical_deployment: actual }));
  for (const project of [undefined, { uses_functions: null, canonical_deployment: actual },
    { uses_functions: true, canonical_deployment: actual }, { uses_functions: false, canonical_deployment: { ...actual, id: 'other' } },
    { uses_functions: false, canonical_deployment: { ...actual, deployment_trigger: { metadata: { commit_hash: 'different', branch: 'main' } } } }]) {
    assert.throws(() => assertSuccessfulStaticDeployment(actual, project), /completed static/);
  }
  assert.throws(() => assertSuccessfulStaticDeployment(deployment({ uses_functions: true }), { uses_functions: false, canonical_deployment: actual }), /completed static/);
});

test('observation checks the immutable artifact and live main rather than trusting build success', async () => {
  const fetched = [];
  const publication = { commit: 'commit-one', branch: 'main' };
  const options = {
    cloudflare: async (route) => route.includes('/deployments?') ? [deployment()] : { canonical_deployment: { id: 'deployment-one' } },
    fetchImpl: async (url) => { fetched.push(url); return new Response(`<body data-probe-site="${plan.repositories[0]}" data-probe-revision="published">ok</body>`); },
  };
  assert.equal((await observeProbeDeployment(plan, plan.repositories[0], publication, options)).state, 'verified');
  assert.equal(fetched.length, 4);
  const notLive = { ...options, cloudflare: async (route) => route.includes('/deployments?') ? [deployment()] : { canonical_deployment: { id: 'different' } } };
  assert.equal((await observeProbeDeployment(plan, plan.repositories[0], publication, notLive)).state, 'waiting');
  await assert.rejects(observeProbeDeployment(plan, plan.repositories[0], publication, { ...options, fetchImpl: async () => new Response('Wrong site') }), /does not match/);
});

test('three-site onboarding resumes pending builds and verifies a version without republishing main', async () => {
  const repositories = new Map();
  const projects = new Map();
  const trees = new Map();
  const commits = new Map([['initial', { tree: { sha: 'empty' } }]]);
  const refs = new Map();
  const deployments = new Map();
  let counter = 0;
  let published = 0;
  const github = async (route, { body } = {}) => {
    if (route === `/orgs/${config.github_owner}/repos`) {
      const repository = { ...body, default_branch: 'main', id: ++counter, owner: { id: 42, login: config.github_owner } };
      repositories.set(body.name, repository);
      refs.set(`${body.name}/main`, 'initial');
      return repository;
    }
    const [, name, endpoint = ''] = route.match(/^\/repos\/synthetic-agency\/([^/]+)(.*)$/) ?? [];
    if (!endpoint) return repositories.get(name) ?? null;
    if (endpoint.startsWith('/git/ref/heads/')) {
      const sha = refs.get(`${name}/${endpoint.slice(15)}`);
      return sha ? { object: { sha } } : null;
    }
    if (endpoint.startsWith('/git/commits/')) return commits.get(endpoint.slice(13));
    if (endpoint === '/git/trees') {
      const sha = digest(JSON.stringify(body.tree));
      trees.set(sha, Object.fromEntries(body.tree.map((entry) => [entry.path, entry.content])));
      return { sha };
    }
    if (endpoint === '/git/commits') {
      const sha = `commit-${++counter}`;
      commits.set(sha, { tree: { sha: body.tree } });
      return { sha };
    }
    if (endpoint === '/git/refs') { refs.set(`${name}/${body.ref.replace('refs/heads/', '')}`, body.sha); return {}; }
    if (endpoint.startsWith('/git/refs/heads/')) {
      const branch = endpoint.slice(16);
      assert.equal(body.force, false);
      refs.set(`${name}/${branch}`, body.sha);
      published++;
      if (projects.has(name)) {
        const item = deployment({
          id: `deploy-${++counter}`, project_name: name,
          deployment_trigger: { metadata: { commit_hash: body.sha, branch } },
          environment: branch === 'main' ? 'production' : 'preview',
          latest_stage: { name: 'build', status: 'active' },
          url: `https://build-${counter}.${name}.pages.dev`,
        });
        deployments.set(item.id, item);
      }
      return {};
    }
    throw new Error('Unexpected GitHub operation');
  };
  const cloudflare = async (route, { body } = {}) => {
    const root = `/accounts/${config.cloudflare_account_id}`;
    if (route === root) return { id: config.cloudflare_account_id };
    if (route === `${root}/pages/projects`) { projects.set(body.name, structuredClone(body)); return projects.get(body.name); }
    const [name, remainder] = route.slice(`${root}/pages/projects/`.length).split('/');
    if (remainder?.startsWith('deployments?')) return [...deployments.values()].filter((entry) => entry.project_name === name);
    return projects.get(name) ?? null;
  };
  const completeBuilds = () => {
    for (const item of deployments.values()) {
      item.latest_stage = { name: 'deploy', status: 'success' };
      if (item.environment === 'production') projects.get(item.project_name).canonical_deployment = { id: item.id };
    }
  };
  const fetchImpl = async (url) => {
    const hostname = new URL(url).hostname;
    const item = [...deployments.values()].find((entry) => new URL(entry.url).hostname === hostname) ??
      deployments.get(projects.get(hostname.replace('.pages.dev', ''))?.canonical_deployment?.id);
    const files = trees.get(commits.get(item.deployment_trigger.metadata.commit_hash).tree.sha);
    const content = JSON.parse(files['publication.json']);
    return new Response(`<body data-probe-site="${content.site}" data-probe-revision="${content.revision}">Synthetic</body>`);
  };
  const clients = { github, cloudflare, fetchImpl, probeMedia: async () => ({ state: 'verified' }) };
  const first = await runPublishingProbe(plan, clients);
  assert.equal(first.state, 'pending');
  assert.equal(repositories.size, 3);
  assert.equal(projects.size, 3);
  completeBuilds();
  const second = await runPublishingProbe(plan, clients);
  assert.equal(second.state, 'pending');
  assert.equal(second.sites.length, 4);
  const mainRefs = plan.repositories.map((name) => refs.get(`${name}/main`));
  completeBuilds();
  const third = await runPublishingProbe(plan, clients);
  assert.equal(third.state, 'verified');
  assert.equal(published, 7); // Three bootstrap, three main publications, one version.
  assert.deepEqual(plan.repositories.map((name) => refs.get(`${name}/main`)), mainRefs);
  assert.equal((await runPublishingProbe(plan, clients)).state, 'verified');
  assert.equal(published, 7);
});


test('Pages lookup uses valid pagination and finds the exact commit beyond the first batch', async () => {
  const target = { project: 'synthetic', commit: 'target', branch: 'main' };
  const wanted = { id: 'wanted', project_name: target.project, environment: 'production', deployment_trigger: { metadata: { commit_hash: target.commit, branch: target.branch } } };
  const calls = [];
  const provider = async route => {
    const url = new URL(route, 'https://example.test');
    assert.equal(url.searchParams.get('per_page'), '25');
    calls.push(Number(url.searchParams.get('page')));
    return calls.length === 1 ? Array.from({ length: 25 }, () => ({ ...wanted, project_name: 'unrelated' })) : [wanted];
  };
  assert.equal((await findPublicationDeployment(provider, '/projects/synthetic', target)).id, 'wanted');
  assert.deepEqual(calls, [1, 2]);
  let count = 0;
  assert.equal(await findPublicationDeployment(async () => { count++; return []; }, '/projects/synthetic', target), null);
  assert.equal(count, 1);
});
