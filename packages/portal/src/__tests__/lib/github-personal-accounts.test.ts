import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { connectionPath, connectionSummary, disconnect, getConnection, openCredentials, sealCredentials } from '../../lib/publishing/connections';
import { finishGithubConnection, githubChoices, selectGithubOrganization, startGithubConnection } from '../../lib/publishing/github-connection';
import { createGithubRepository, type GithubUserGrant } from '../../lib/publishing/github-user';
import { checkGithubPermissions } from '../../lib/publishing/github-permissions';
import { githubInstallationClient, publishTree, ensureGithubMainBranch } from '../../lib/publishing/providers.mjs';

const session = { userId: 'synthetic-editor', email: 'editor@example.invalid', orgId: 'synthetic-org' };
const user = { id: 78, login: 'synthetic-person', type: 'User' };
const installation = { id: 34, app_id: 12, account: user, repository_selection: 'all', suspended_at: null, permissions: { contents: 'write', administration: 'write' } };
const tokens = { access_token: 'synthetic-user-access', refresh_token: 'synthetic-refresh', expires_in: 28800, refresh_token_expires_in: 15897600 };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const path = connectionPath(session.orgId, 'github');
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  for (const [name, value] of Object.entries({ INTEGRATIONS_SECRET_KEY: 'synthetic-encryption-key-for-tests-only-32chars', PORTAL_PUBLIC_URL: 'http://localhost',
    TYPEROLL_PUBLISH_GITHUB_APP_ID: '12', TYPEROLL_PUBLISH_GITHUB_CLIENT_ID: 'synthetic-client', TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET: 'synthetic-client-secret',
    TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY: privateKey, TYPEROLL_PUBLISH_GITHUB_APP_SLUG: 'synthetic-publisher' })) vi.stubEnv(name, value);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function provider(overrides: Record<string, any> = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    const results: Record<string, any> = {
      '/login/oauth/access_token': tokens, '/user': user, '/users/synthetic-person': user,
      '/user/installations?per_page=100&page=1': { installations: [installation] },
      '/app/installations/34': installation, '/app/installations/34/access_tokens': { token: 'synthetic-installation-access' },
      '/user/repos': { id: 99, name: 'typeroll-site', owner: user, private: true },
      ...overrides,
    };
    expect(init?.redirect).toBe('error');
    const key = target.pathname + target.search;
    if (!(key in results)) throw Error('Unexpected provider request');
    const result = results[key];
    return result instanceof Response ? result : Response.json(result);
  });
}
async function connect(fetcher = provider()) {
  const started = await startGithubConnection(session);
  const input = { ...started, state: new URL(started.url).searchParams.get('state')!, code: 'synthetic-code' };
  return finishGithubConnection(session, input, fetcher);
}
const createBody = { name: 'typeroll-site', private: true, auto_init: true };
async function expire() {
  const current = await getConnection(session.orgId, 'github');
  const grant = openCredentials<GithubUserGrant>(session.orgId, 'github', current.encrypted_credentials!);
  await getStore().updateDoc(path, { encrypted_credentials: sealCredentials(session.orgId, 'github', { ...grant, expires_at: Date.now() - 1 }) });
}
it('connects only the signed-in personal owner, encrypts the grant and exposes no credentials', async () => {
  expect(await connect()).toBe('connected');
  const saved = await getConnection(session.orgId, 'github');
  expect(saved.github).toMatchObject({ account_type: 'User', account_id: '78', owner: 'synthetic-person' });
  expect(openCredentials<GithubUserGrant>(session.orgId, 'github', saved.encrypted_credentials!)).toMatchObject({ user_id: '78', access_token: tokens.access_token });
  const publicState = JSON.stringify(connectionSummary(saved));
  for (const value of Object.values(tokens).filter(v => typeof v === 'string')) { expect(JSON.stringify(saved)).not.toContain(value); expect(publicState).not.toContain(value); }
  expect(connectionSummary(saved).github).toMatchObject({ account_type: 'User', repository_creation_state: 'ready' });
});
it.each([
  { '/user': { ...user, id: 999 } },
  { '/user/installations?per_page=100&page=1': { installations: [{ ...installation, repository_selection: 'selected' }] } },
  { '/app/installations/34': { ...installation, suspended_at: '2026-09-11' } },
  { '/users/synthetic-person': { ...user, id: 999 } },
  { '/app/installations/34': { ...installation, account: { ...user, id: 999 } } },
  { '/app/installations/34': { ...installation, account: { ...user, type: 'Organization' } } },
  { '/login/oauth/access_token': { access_token: 'synthetic-no-refresh' } },
])('rejects unproven personal authority or a nonrenewable grant', async overrides => {
  await expect(connect(provider(overrides))).rejects.toThrow();
  expect((await getConnection(session.orgId, 'github')).status).toBe('disconnected');
});
it('offers the personal account alongside owned organizations and clears pending tokens after selection', async () => {
  const orgInstall = { ...installation, id: 35, account: { id: 56, login: 'synthetic-company', type: 'Organization' }, permissions: { ...installation.permissions, members: 'read' } };
  const fetcher = provider({ '/user/installations?per_page=100&page=1': { installations: [orgInstall, installation] },
    '/orgs/synthetic-company/memberships/synthetic-person': { state: 'active', role: 'admin', user: { id: 78 }, organization: { id: 56 } } });
  expect(await connect(fetcher)).toBe('select');
  expect((await githubChoices(session)).map(c => c.account_type)).toEqual(['Organization', 'User']);
  await expect(selectGithubOrganization({ ...session, userId: 'other' }, '34', fetcher)).rejects.toThrow('expired');
  await selectGithubOrganization(session, '34', fetcher);
  expect((await getConnection(session.orgId, 'github')).github?.account_type).toBe('User');
  expect((await getStore().getDoc<any>(`organizations/${session.orgId}/publishing_authorizations/github_selection`)).encrypted_tokens).toBeNull();
  await expect(selectGithubOrganization(session, '34', fetcher)).rejects.toThrow('expired');
});
it('uses the personal creation endpoint and keeps all branch publication on installation authority', async () => {
  await connect(); const saved = await getConnection(session.orgId, 'github'); const root = '/repos/synthetic-person/typeroll-site';
  const fetcher = provider({
    [`${root}/git/ref/heads/version-blue`]: { object: { sha: 'parent' } },
    [`${root}/git/commits/parent`]: { tree: { sha: 'old-tree' } },
    [`${root}/git/trees`]: { sha: 'new-tree' },
    [`${root}/git/commits`]: { sha: 'new-commit' },
    [`${root}/git/refs/heads/version-blue`]: { object: { sha: 'new-commit' } },
  });
  const github = await githubInstallationClient({ appId: '12', installationId: '34', privateKey, owner: user.login }, fetcher);
  await createGithubRepository(session.orgId, github, saved.github!, createBody, fetcher);
  const creation = fetcher.mock.calls.find(([url]) => new URL(String(url)).pathname === '/user/repos')!;
  expect(creation[1]?.headers).toMatchObject({ Authorization: `Bearer ${tokens.access_token}` });
  await publishTree(github, { owner: user.login, repo: 'typeroll-site', branch: 'version-blue', files: { 'index.html': 'synthetic' }, message: 'Publish version' });
  const gitWrites = fetcher.mock.calls.filter(([url]) => String(url).includes('/git/'));
  expect(gitWrites.some(([url]) => String(url).endsWith('/git/refs/heads/version-blue'))).toBe(true);
  for (const [, init] of gitWrites) expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-installation-access' });
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/orgs/'))).toBe(false);
});
it('serializes rotating refresh tokens across simultaneous repository creations', async () => {
  await connect(); await expire(); const saved = await getConnection(session.orgId, 'github');
  const fetcher = provider({ '/login/oauth/access_token': { ...tokens, access_token: 'synthetic-renewed-access', refresh_token: 'synthetic-renewed-refresh' } });
  const installationClient = vi.fn();
  await Promise.all([1, 2].map(() => createGithubRepository(session.orgId, installationClient, saved.github!, createBody, fetcher)));
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/login/oauth/access_token'))).toHaveLength(1);
  expect(installationClient).not.toHaveBeenCalled();
  const current = await getConnection(session.orgId, 'github');
  expect(current.revision).toBe(saved.revision);
  expect(current.refresh_lease).toBeNull();
  expect(openCredentials<GithubUserGrant>(session.orgId, 'github', current.encrypted_credentials!).refresh_token).toBe('synthetic-renewed-refresh');
});
it('does not restore authorization or create a repository if disconnected during refresh', async () => {
  await connect(); await expire(); const saved = await getConnection(session.orgId, 'github'); const fallback = provider();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('/login/oauth/access_token')) await disconnect(session.orgId, 'github', saved.revision);
    return fallback(url, init);
  });
  await expect(createGithubRepository(session.orgId, vi.fn(), saved.github!, createBody, fetcher)).rejects.toThrow('changed');
  expect((await getConnection(session.orgId, 'github')).encrypted_credentials).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/user/repos'))).toBe(false);
});
it('reports revoked authorization without exposing provider text or deleting the installation', async () => {
  await connect(); await expire(); const saved = await getConnection(session.orgId, 'github');
  await expect(createGithubRepository(session.orgId, vi.fn(), saved.github!, createBody, provider({ '/login/oauth/access_token': { error: 'bad_refresh_token', error_description: tokens.refresh_token } }))).rejects.toMatchObject({ code: 'github_reauthorization_required' });
  const current = await getConnection(session.orgId, 'github');
  expect(current.status).toBe('connected'); expect(current.github).toEqual(saved.github);
  expect(connectionSummary(current).github?.repository_creation_state).toBe('reconnect_required');
  expect(current.refresh_lease).toBeNull();
});
it('uses the personal installation settings URL for permission approval', async () => {
  await connect();
  const result = await checkGithubPermissions(session.orgId, provider({ '/app': { id: 12, permissions: { ...installation.permissions, actions: 'write', workflows: 'write' } } }));
  expect(result.approval_url).toBe('https://github.com/settings/installations/34');
});
it('preserves organization repository creation without storing or using a personal grant', async () => {
  const github = vi.fn(async () => ({ id: 99 }));
  await createGithubRepository(session.orgId, github, { app_id: '12', installation_id: '35', account_id: '56', owner: 'synthetic-company' }, createBody);
  expect(github).toHaveBeenCalledWith('/orgs/synthetic-company/repos', { method: 'POST', body: createBody });
});

it('renews once after an unexpected access-token rejection before asking to reconnect', async () => {
  await connect(); const saved = await getConnection(session.orgId, 'github');
  const fallback = provider({ '/login/oauth/access_token': { ...tokens, access_token: 'synthetic-new-access' } });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (new URL(String(url)).pathname === '/user' && (init?.headers as any).Authorization === `Bearer ${tokens.access_token}`) return new Response(null, { status: 401 });
    return fallback(url, init);
  });
  await createGithubRepository(session.orgId, vi.fn(), saved.github!, createBody, fetcher);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/login/oauth/access_token'))).toHaveLength(1);
  expect((await getConnection(session.orgId, 'github')).github_authorization_required).toBe(false);
});
it('retains encrypted authorization on a transient refresh failure without leaking the provider body', async () => {
  await connect(); await expire(); const saved = await getConnection(session.orgId, 'github');
  await expect(createGithubRepository(session.orgId, vi.fn(), saved.github!, createBody, provider({ '/login/oauth/access_token': Response.json({ error: tokens.refresh_token }, { status: 503 }) }))).rejects.toMatchObject({ code: 'github_refresh_unavailable' });
  expect((await getConnection(session.orgId, 'github')).encrypted_credentials).toBe(saved.encrypted_credentials);
  expect((await getConnection(session.orgId, 'github')).refresh_lease).toBeNull();
});

it('prepares main using installation authority when the account defaults new repositories to another branch', async () => {
  const repository = { id: 99, owner: user, private: true, default_branch: 'custom-default' };
  const github = vi.fn(async (route: string) => route.endsWith('/rename') ? { name: 'main' } : { ...repository, default_branch: 'main' });
  expect((await ensureGithubMainBranch(github, { owner: user.login, repo: 'typeroll-site', repository })).default_branch).toBe('main');
  expect(github).toHaveBeenCalledWith('/repos/synthetic-person/typeroll-site/branches/custom-default/rename', { method: 'POST', body: { new_name: 'main' } });
});
