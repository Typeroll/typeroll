import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createHash } from 'node:crypto';
import type { APIRoute } from 'astro';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { claimAccount, connectionPath, connectionSummary, disconnect, getConnection, openCredentials, sealCredentials } from '../../lib/publishing/connections';
import { CLOUDFLARE_SCOPES } from '../../lib/publishing/cloudflare-oauth';
import { finishGithubConnection, githubNextStep, startGithubInstallation, resumeGithubInstallation, githubSetup, startGithubConnection, githubChoices, selectGithubOrganization } from '../../lib/publishing/github-connection';
import { connectCloudflare, verifyR2, prepareCloudflareMedia, connectCloudflareMedia } from '../../lib/publishing/cloudflare-connection';
import { GET } from '../../pages/api/orgs/publishing/index';
import { checkGithubPermissions } from '../../lib/publishing/github-permissions';
import { GET as GITHUB_PERMISSIONS } from '../../pages/api/orgs/publishing/github/permissions';
import { POST, DELETE } from '../../pages/api/orgs/publishing/[provider]';
import { GET as CALLBACK } from '../../pages/api/orgs/publishing/github/callback';
import { GET as CLOUDFLARE_CALLBACK } from '../../pages/api/orgs/publishing/cloudflare/callback';
import { createE2ESessionCookie } from '../../lib/e2e-auth';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const session = { userId: 'dev-user', email: 'dev@typeroll.local', orgId: 'default' };
const accountId = 'a'.repeat(32);
const credentials = { api_token: 'synthetic-cf-token', access_key_id: 'synthetic-r2-key', secret_access_key: 'synthetic-r2-secret' };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const installation = { id: 34, app_id: 12, account: { id: 56, login: 'synthetic-agency', type: 'Organization' }, repository_selection: 'all',
  suspended_at: null, permissions: { contents: 'write', administration: 'write', members: 'read' } };

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
  vi.stubEnv('TYPEROLL_PUBLISH_GITHUB_APP_ID', '12');
  vi.stubEnv('TYPEROLL_PUBLISH_GITHUB_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET', 'synthetic-client-secret');
  vi.stubEnv('TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY', privateKey);
  vi.stubEnv('TYPEROLL_PUBLISH_GITHUB_APP_SLUG', 'synthetic-publisher');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-cloudflare-client');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-cloudflare-secret');
  await getStore().setDoc('organizations/default/members/dev-user', { role: 'owner' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function providerFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const results: Record<string, unknown> = {
      '/login/oauth/access_token': { access_token: 'synthetic-user-token' },
      '/user': { id: 78, login: 'synthetic-owner' },
      '/user/installations?per_page=100&page=1': { installations: [installation] },
      '/orgs/synthetic-agency/memberships/synthetic-owner': { state: 'active', role: 'admin', user: { id: 78 }, organization: { id: 56 } },
      '/app/installations/34': installation,
      '/app/installations/34/access_tokens': { token: 'synthetic-installation-token' },
      '/orgs/synthetic-agency': { id: 56 },
      [`/client/v4/accounts/${accountId}`]: { success: true, result: { id: accountId, name: 'Synthetic agency' } },
      [`/client/v4/accounts/${accountId}/pages/projects?per_page=1`]: { success: true, result: [] },
      [`/client/v4/accounts/${accountId}/r2/buckets/agency-media/domains/managed`]: { success: true, result: { enabled: false } },
      [`/client/v4/accounts/${accountId}/r2/buckets/agency-media/domains/custom`]: { success: true, result: { domains: [] } },
      ...overrides,
    };
    expect(init?.redirect).toBe('error');
    if (!(path in results)) throw new Error('Unexpected provider request');
    const result = results[path];
    return result instanceof Response ? result : Response.json(result);
  });
}

async function authorization() {
  const started = await startGithubConnection(session, 'synthetic-agency');
  return { ...started, state: new URL(started.url).searchParams.get('state')!, code: 'synthetic-code' };
}

function routeContext(method = 'GET', provider = 'github', body?: unknown, origin = 'http://localhost') {
  const url = new URL(`http://localhost/api/orgs/publishing/${provider}`);
  return { url, params: { provider }, cookies: { get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() },
    request: new Request(url, { method, headers: { 'Content-Type': 'application/json', Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
}
async function call(route: APIRoute, context: ReturnType<typeof routeContext>) {
  return await route(context as unknown as Parameters<APIRoute>[0]) as Response;
}

describe('GitHub organization authorization', () => {
  it('binds a verified organization owner and App installation, uses PKCE, and persists no token', async () => {
    const input = await authorization();
    const fetcher = providerFetch();
    await finishGithubConnection(session, input, fetcher);
    const connection = await getConnection('default', 'github');
    expect(connection.github).toEqual({ app_id: '12', installation_id: '34', account_id: '56', owner: 'synthetic-agency' });
    expect(connection.status).toBe('connected');
    const exchange = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(new URL(input.url).searchParams.get('code_challenge')).toBe(createHash('sha256').update(exchange.code_verifier).digest('base64url'));
    expect(exchange.redirect_uri).toBe('http://localhost/api/orgs/publishing/github/callback');
    const stored = JSON.stringify([connection, await getStore().getDoc('organizations/default/publishing_authorizations/github')]);
    for (const value of ['synthetic-user-token', 'synthetic-installation-token', exchange.code_verifier, 'synthetic-client-secret', input.state, input.browser]) expect(stored).not.toContain(value);
    await expect(finishGithubConnection(session, input, fetcher)).rejects.toThrow('expired');
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it.each(['browser', 'state', 'user', 'organization', 'expired'])('rejects mismatched %s before contacting GitHub', async (kind) => {
    const input = await authorization();
    if (kind === 'browser' || kind === 'state') input[kind] = 'x'.repeat(43);
    if (kind === 'expired') await getStore().updateDoc('organizations/default/publishing_authorizations/github', { expires_at: Date.now() - 1 });
    const actor = { ...session, ...(kind === 'user' ? { userId: 'someone-else' } : {}), ...(kind === 'organization' ? { orgId: 'other' } : {}) };
    const fetcher = providerFetch();
    await expect(finishGithubConnection(actor, input, fetcher)).rejects.toThrow('expired');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { '/user/installations?per_page=100&page=1': { installations: [] } },
    { '/user/installations?per_page=100&page=1': { installations: [{ ...installation, repository_selection: 'selected' }] } },
    { '/user/installations?per_page=100&page=1': { installations: [{ ...installation, permissions: { contents: 'write', administration: 'write' } }] } },
    { '/orgs/synthetic-agency/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 56 } } },
    { '/orgs/synthetic-agency/memberships/synthetic-owner': { state: 'active', role: 'admin', user: { id: 999 }, organization: { id: 56 } } },
    { '/app/installations/34': { ...installation, suspended_at: '2026-09-07' } },
    { '/orgs/synthetic-agency': { id: 999 } },
  ])('rejects unproven or changed installation authority', async (overrides) => {
    await expect(finishGithubConnection(session, await authorization(), providerFetch(overrides))).rejects.toThrow();
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
  });

  it('paginates installations and allows only one callback to finish', async () => {
    const input = await authorization();
    const fetcher = providerFetch({ '/user/installations?per_page=100&page=1': { installations: Array(100).fill({ app_id: 999 }) },
      '/user/installations?per_page=100&page=2': { installations: [installation] } });
    const results = await Promise.allSettled([finishGithubConnection(session, input, fetcher), finishGithubConnection(session, input, fetcher)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('access_token'))).toHaveLength(2);
  });

  it('does not let an old authorization undo a disconnect or claim another tenant’s account', async () => {
    const input = await authorization();
    await disconnect('default', 'github', (await getConnection('default', 'github')).revision);
    await expect(finishGithubConnection(session, input, providerFetch())).rejects.toThrow('changed');
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
    await getStore().setDoc('publishing_account_claims/github-56', { org_id: 'another-agency' });
    await expect(finishGithubConnection(session, await authorization(), providerFetch())).rejects.toThrow('another Typeroll organization');
  });

  it('discovers the organization after sign-in without a typed name or ID', async () => {
    const started = await startGithubConnection(session);
    const input = { ...started, state: new URL(started.url).searchParams.get('state')!, code: 'synthetic-code' };
    expect(await finishGithubConnection(session, input, providerFetch())).toBe('connected');
    expect((await getConnection('default', 'github')).github?.owner).toBe('synthetic-agency');
  });

  it('offers only proven owner organizations and requires an explicit selection when several exist', async () => {
    const second = { ...installation, id: 35, account: { ...installation.account, id: 57, login: 'second-agency' } };
    const fetcher = providerFetch({
      '/user/installations?per_page=100&page=1': { installations: [installation, second] },
      '/orgs/second-agency/memberships/synthetic-owner': { state: 'active', role: 'admin', user: { id: 78 }, organization: { id: 57 } },
      '/app/installations/35': second,
      '/app/installations/35/access_tokens': { token: 'synthetic-second-token' },
      '/orgs/second-agency': { id: 57 },
    });
    const started = await startGithubConnection(session);
    expect(await finishGithubConnection(session, { ...started, state: new URL(started.url).searchParams.get('state')!, code: 'synthetic-code' }, fetcher)).toBe('select');
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
    expect(await githubChoices(session)).toHaveLength(2);
    expect(await githubChoices({ ...session, userId: 'other-user' })).toEqual([]);
    await expect(selectGithubOrganization({ ...session, userId: 'other-user' }, '35', fetcher)).rejects.toThrow('expired');
    await expect(selectGithubOrganization(session, '999', fetcher)).rejects.toThrow('expired');
    expect(JSON.stringify(await getStore().getDoc('organizations/default/publishing_authorizations/github_selection'))).not.toContain('synthetic-user-token');
    await selectGithubOrganization(session, '35', fetcher);
    expect((await getConnection('default', 'github')).github?.owner).toBe('second-agency');
    expect(await githubChoices(session)).toEqual([]);
    await expect(selectGithubOrganization(session, '35', fetcher)).rejects.toThrow('expired');
  });

  it.each(['expired', 'other-user', 'other-organization', 'revoked-owner', 'changed-connection'])('rejects a pending choice with %s authority', async (failure) => {
    const revision = (await getConnection('default', 'github')).revision;
    await getStore().setDoc('organizations/default/publishing_authorizations/github_selection', {
      user_id: session.userId, github_user: { id: 78, login: 'synthetic-owner' }, revision,
      expires_at: failure === 'expired' ? Date.now() - 1 : Date.now() + 60_000, consumed: false,
      choices: [{ owner: 'synthetic-agency', installation_id: '34', account_id: '56' }],
    });
    if (failure === 'changed-connection') await disconnect('default', 'github', revision);
    const fetcher = providerFetch(failure === 'revoked-owner' ? {
      '/orgs/synthetic-agency/memberships/synthetic-owner': { state: 'active', role: 'member', user: { id: 78 }, organization: { id: 56 } },
    } : {});
    const actor = { ...session, ...(failure === 'other-user' ? { userId: 'other-user' } : {}), ...(failure === 'other-organization' ? { orgId: 'other-org' } : {}) };
    await expect(selectGithubOrganization(actor, '34', fetcher)).rejects.toThrow();
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
    if (['expired', 'other-user', 'other-organization'].includes(failure)) expect(fetcher).not.toHaveBeenCalled();
  });

  it('gives a useful error for the legacy field with a display name containing spaces', async () => {
    await expect(startGithubConnection(session, 'Synthetic Agency')).rejects.toThrow('without spaces');
  });

  it('requires publisher configuration without accepting request-controlled callbacks', async () => {
    vi.stubEnv('PORTAL_PUBLIC_URL', 'https://trusted.test@untrusted.test/path');
    expect(githubSetup().available).toBe(false);
    await expect(authorization()).rejects.toThrow('configuration');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
    vi.stubEnv('TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET', '');
    expect(githubSetup().available).toBe(false);
  });
});

describe('GitHub installation continuation', () => {
  const grantPath = 'organizations/default/publishing_authorizations/github';
  async function requireInstallation() {
    const input = await authorization();
    await expect(finishGithubConnection(session, input, providerFetch({
      '/user/installations?per_page=100&page=1': { installations: [] },
    }))).rejects.toMatchObject({ code: 'install_required' });
    return input;
  }
  it('persists the required step across page reloads without persisting the user token', async () => {
    await requireInstallation();
    expect(await githubNextStep(session)).toBe('install');
    const response = await call(GET, routeContext());
    expect(await response.json()).toMatchObject({ github_next_step: 'install', github: { status: 'disconnected' } });
    const stored = await getStore().getDoc<any>(grantPath);
    expect(JSON.stringify(stored)).not.toContain('synthetic-user-token');
    expect(stored.encrypted_verifier).toBeNull();
    await getStore().updateDoc(grantPath, { expires_at: Date.now() - 1 });
    // An expired browser visit does not hide the missing installation; the CTA renews it.
    expect(await githubNextStep(session)).toBe('install');
    expect(await githubNextStep({ ...session, userId: 'other' })).toBeNull();
    await disconnect('default', 'github', (await getConnection('default', 'github')).revision);
    expect(await githubNextStep(session)).toBeNull();
  });
  it('returns from installation through fresh PKCE, then verifies owner and permissions before connecting', async () => {
    const original = await requireInstallation();
    const post = routeContext('POST', 'github', { action: 'install' });
    const installed = await call(POST, post);
    const url = new URL((await installed.json()).authorization_url);
    expect(url.origin + url.pathname).toBe('https://github.com/apps/synthetic-publisher/installations/new');
    const browser = post.cookies.set.mock.calls[0][1];
    const context = routeContext();
    context.url = new URL('http://localhost/api/orgs/publishing/github/callback');
    context.url.searchParams.set('state', url.searchParams.get('state')!);
    context.url.searchParams.set('installation_id', '999999');
    context.url.searchParams.set('code', 'untrusted-installation-code');
    context.cookies.get.mockImplementation(((name: string) => name === 'typeroll_publishing_github' ? { value: browser } : undefined) as any);
    const fetcher = providerFetch(); vi.stubGlobal('fetch', fetcher);
    const resumed = await call(CALLBACK, context);
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get('referrer-policy')).toBe('no-referrer');
    const next = new URL(resumed.headers.get('location')!);
    expect(next.origin + next.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(next.searchParams.get('code_challenge_method')).toBe('S256');
    expect(next.searchParams.get('state')).not.toBe(original.state);
    expect(context.cookies.delete).not.toHaveBeenCalled();
    expect(context.cookies.set).toHaveBeenCalledWith('typeroll_publishing_github', expect.any(String), expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
    expect(fetcher).not.toHaveBeenCalled();
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
    const input = { state: next.searchParams.get('state')!, browser: context.cookies.set.mock.calls[0][1], code: 'fresh-pkce-code' };
    expect(await finishGithubConnection(session, input, fetcher)).toBe('connected');
    expect(await githubNextStep(session)).toBeNull();
    expect((await getConnection('default', 'github')).github?.installation_id).toBe('34');
    const exchange = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(exchange.code).toBe('fresh-pkce-code');
    expect(next.searchParams.get('code_challenge')).toBe(createHash('sha256').update(exchange.code_verifier).digest('base64url'));
  });
  it.each(['browser', 'state', 'expired', 'user', 'organization', 'connection'])('rejects installation return with changed %s', async kind => {
    await requireInstallation(); const started = await startGithubInstallation(session);
    const input = { state: new URL(started.url).searchParams.get('state')!, browser: started.browser };
    if (kind === 'browser') input.browser = 'x'.repeat(43);
    if (kind === 'state') input.state = 'install_' + 'x'.repeat(43);
    if (kind === 'expired') await getStore().updateDoc(grantPath, { expires_at: Date.now() - 1 });
    if (kind === 'connection') await disconnect('default', 'github', (await getConnection('default', 'github')).revision);
    const actor = { ...session, ...(kind === 'user' ? { userId: 'other' } : {}), ...(kind === 'organization' ? { orgId: 'other' } : {}) };
    await expect(resumeGithubInstallation(actor, input)).rejects.toThrow('expired');
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
  });
  it('consumes the installation return once and never exchanges its unbound code', async () => {
    await requireInstallation(); const started = await startGithubInstallation(session);
    const input = { state: new URL(started.url).searchParams.get('state')!, browser: started.browser };
    const fetcher = providerFetch();
    await expect(finishGithubConnection(session, { ...input, code: 'installation-code' }, fetcher)).rejects.toThrow('expired');
    expect(fetcher).not.toHaveBeenCalled();
    const results = await Promise.allSettled([resumeGithubInstallation(session, input), resumeGithubInstallation(session, input)]);
    expect(results.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
  it('does not infer installation success after cancellation or an owner approval request', async () => {
    await requireInstallation(); const started = await startGithubInstallation(session);
    await resumeGithubInstallation(session, { state: new URL(started.url).searchParams.get('state')!, browser: started.browser });
    await requireInstallation();
    expect(await githubNextStep(session)).toBe('install');
    expect((await getConnection('default', 'github')).status).toBe('disconnected');
  });
  it('does not overwrite a newer connection attempt with the old callback result', async () => {
    const input = await authorization(), fallback = providerFetch({ '/user/installations?per_page=100&page=1': { installations: [] } });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/user/installations')) await startGithubConnection(session);
      return fallback(url, init);
    });
    await expect(finishGithubConnection(session, input, fetcher)).rejects.toMatchObject({ code: 'install_required' });
    expect(await githubNextStep(session)).toBeNull();
  });
});

function fakeS3(fail?: 'put' | 'read' | 'delete') {
  let stored = '';
  return vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof PutObjectCommand) { if (fail === 'put') throw new Error(credentials.secret_access_key); stored = command.input.Body as string; return {}; }
    if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => fail === 'read' ? 'wrong content' : stored } };
    if (command instanceof DeleteObjectCommand) { if (fail === 'delete') throw new Error(credentials.api_token); return {}; }
    throw new Error('Unexpected S3 operation');
  }) as any);
}

describe('Cloudflare connection and encrypted credentials', () => {
  it('reports R2 ready only after upload verification, including legacy key connections', () => {
    const connection = { revision: 'synthetic-revision', status: 'connected' as const, auth_method: 'oauth' as const,
      encrypted_credentials: 'synthetic-ciphertext',
      cloudflare: { account_id: accountId, account_name: 'Synthetic agency', bucket: 'agency-media', public_bucket: 'public-media', endpoint: 'https://example.test' } };
    expect(connectionSummary(connection).media_ready).toBe(false);
    expect(connectionSummary({ ...connection, media_ready: true }).media_ready).toBe(true);
    expect(connectionSummary({ ...connection, media_ready: true, status: 'disconnected' }).media_ready).toBe(false);
    expect(connectionSummary({ ...connection, media_ready: true, encrypted_credentials: null }).media_ready).toBe(false);
    expect(connectionSummary({ ...connection, media_ready: true, cloudflare: { ...connection.cloudflare, bucket: '' } }).media_ready).toBe(false);
    expect(connectionSummary({ ...connection, auth_method: 'api_token' }).media_ready).toBe(false);
    expect(connectionSummary({ ...connection, media_ready: true, cloudflare: { ...connection.cloudflare, public_bucket: undefined } }).media_ready).toBe(false);
    expect(connectionSummary({ ...connection, auth_method: 'api_token', media_ready: false }).media_ready).toBe(false);
  });
  it.each([false, true])('prepares separate private and public organization buckets and reuses it when OAuth needs refresh: %s', async (refreshRequired) => {
    await getConnection('default', 'cloudflare');
    await getStore().updateDoc(connectionPath('default', 'cloudflare'), { status: 'connected',
      cloudflare: { account_id: accountId, account_name: 'Synthetic agency', bucket: '', endpoint: `https://${accountId}.r2.cloudflarestorage.com` },
      encrypted_credentials: sealCredentials('default', 'cloudflare', refreshRequired ? { oauth: { access_token: 'expired-access', refresh_token: 'synthetic-refresh', expires_at: 0, scope: CLOUDFLARE_SCOPES.join(' ') } } : { api_token: credentials.api_token }) });
    const buckets = new Set<string>();
    let rules = [{ id: 'existing-reader', allowed: { origins: ['https://existing.example'], methods: ['GET'] } }];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/oauth2/token') return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer', scope: CLOUDFLARE_SCOPES.join(' ') });
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      expect(init?.redirect).toBe('error');
      if (pathname.endsWith('/domains/managed')) return Response.json({ success: true, result: { enabled: false } });
      if (pathname.endsWith('/domains/custom')) return Response.json({ success: true, result: { domains: [] } });
      if (pathname.endsWith('/lifecycle')) {
        if (init?.method === 'PUT') expect(body.rules.at(-1)).toMatchObject({ conditions: { prefix: 'build-grants/' }, deleteObjectsTransition: { condition: { maxAge: 86400 } } });
        return Response.json({ success: true, result: { rules: [] } });
      }
      if (pathname.endsWith('/cors')) {
        if (init?.method === 'PUT') rules = body.rules;
        return Response.json({ success: true, result: { rules } });
      }
      if (init?.method === 'POST') buckets.add(body.name);
      const requested = pathname.split('/').at(-1)!;
      if (!buckets.has(requested) && init?.method !== 'POST') return new Response(null, { status: 404 });
      return Response.json({ success: true, result: { name: body?.name ?? requested, jurisdiction: 'default' } });
    });
    for (let i = 0; i < 2; i++) await prepareCloudflareMedia(session, (await getConnection('default', 'cloudflare')).revision, fetcher);
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/r2/buckets') && init?.method === 'POST')).toHaveLength(2);
    expect([...buckets].sort()).toEqual([expect.stringMatching(/^typeroll-media-[a-f0-9]{16}$/), expect.stringMatching(/^typeroll-public-[a-f0-9]{16}$/)]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ id: 'existing-reader', allowed: { origins: ['https://existing.example'], methods: ['GET'] } });
    expect(rules[1]).toMatchObject({ id: 'typeroll-direct-uploads', allowed: { origins: ['http://localhost'], methods: ['GET', 'HEAD', 'PUT'] } });
    expect((await getConnection('default', 'cloudflare')).media_ready).not.toBe(true);
  });

  it.each([false, true])('saves verified R2 keys when OAuth needs refresh: %s', async (refreshRequired) => {
    fakeS3();
    await getConnection('default', 'cloudflare');
    const oauth = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: refreshRequired ? 0 : Date.now() + 3600_000, scope: CLOUDFLARE_SCOPES.join(' ') };
    await getStore().updateDoc(connectionPath('default', 'cloudflare'), { status: 'connected', auth_method: 'oauth',
      cloudflare: { account_id: accountId, bucket: 'agency-media', public_bucket: 'published-media' }, encrypted_credentials: sealCredentials('default', 'cloudflare', { oauth }) });
    const current = await getConnection('default', 'cloudflare');
    await connectCloudflareMedia(session, { revision: current.revision, access_key_id: credentials.access_key_id, secret_access_key: credentials.secret_access_key }, providerFetch({ '/oauth2/token': { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer', scope: CLOUDFLARE_SCOPES.join(' ') } }));
    const saved = await getConnection('default', 'cloudflare');
    expect(saved.media_ready).toBe(true);
    expect(openCredentials('default', 'cloudflare', saved.encrypted_credentials!)).toEqual({ oauth: refreshRequired ? expect.objectContaining({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }) : oauth, access_key_id: credentials.access_key_id, secret_access_key: credentials.secret_access_key });
    expect(JSON.stringify(saved)).not.toContain('synthetic-refresh');
    await expect(connectCloudflareMedia(session, { revision: current.revision, access_key_id: 'changed', secret_access_key: 'changed' })).rejects.toThrow('reload');
  });

  it('verifies account, Pages access and R2 read/write/delete before saving encrypted credentials', async () => {
    const s3 = fakeS3();
    const revision = (await getConnection('default', 'cloudflare')).revision;
    await connectCloudflare(session, { ...credentials, account_id: accountId, bucket: 'agency-media', revision }, providerFetch());
    const connection = await getConnection('default', 'cloudflare');
    expect(connection.status).toBe('connected');
    expect(connection.cloudflare?.account_id).toBe(accountId);
    expect(s3.mock.calls.map(([command]) => command.constructor.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
    expect(openCredentials('default', 'cloudflare', connection.encrypted_credentials!)).toEqual(credentials);
    for (const secret of Object.values(credentials)) expect(JSON.stringify(connection)).not.toContain(secret);
    expect(JSON.stringify(connectionSummary(connection))).not.toContain('encrypted_credentials');
    await disconnect('default', 'cloudflare', connection.revision);
    const disconnected = await getConnection('default', 'cloudflare');
    expect(disconnected.encrypted_credentials).toBeNull();
    expect(connectionSummary(disconnected).credentials_saved).toBe(false);
  });

  it.each(['put', 'read', 'delete'] as const)('fails closed on R2 %s failure and attempts cleanup without reflecting credentials', async (failure) => {
    const s3 = fakeS3(failure);
    await expect(verifyR2(accountId, 'agency-media', credentials)).rejects.toThrow('R2 verification failed');
    expect(s3.mock.calls.at(-1)?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it.each([
    ['AccessDenied', 403, 'write', 'Object Read & Write'],
    ['SignatureDoesNotMatch', 403, 'write', 'matching pair'],
    ['InvalidAccessKeyId', 403, 'write', 'did not recognize'],
    ['NoSuchBucket', 404, 'write', 'could not find'],
    ['TimeoutError', undefined, 'read', 'same keys'],
    ['ServiceUnavailable', 503, 'delete', 'temporarily unavailable'],
  ] as const)('reports %s at the failing %s step without reflecting provider secrets', async (name, status, phase, explanation) => {
    let stored = '';
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
      const step = command instanceof PutObjectCommand ? 'write' : command instanceof GetObjectCommand ? 'read' : 'delete';
      if (step === phase) throw Object.assign(new Error(credentials.secret_access_key), { name, $metadata: { httpStatusCode: status } });
      if (command instanceof PutObjectCommand) stored = command.input.Body as string;
      return { Body: { transformToString: async () => stored } };
    }) as any);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let caught: any;
    try { await verifyR2(accountId, 'published-media', credentials); } catch (error) { caught = error; }
    expect(caught?.diagnostic).toMatchObject({ step: phase, provider_code: name, http_status: status ?? null, bucket: 'published-media' });
    expect(caught?.message).toContain(explanation);
    expect(caught?.message).toContain('These submitted keys have not been saved');
    expect(JSON.stringify([caught, warning.mock.calls])).not.toContain(credentials.secret_access_key);
  });

  it('explains HTTP authentication rejection even when R2 supplies no S3 error code', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue({ name: 'Error', $metadata: { httpStatusCode: 401 } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(verifyR2(accountId, 'agency-media', credentials)).rejects.toThrow('Cloudflare rejected authentication');
  });

  it('preserves the write failure when cleanup also fails and strips arbitrary provider data', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
      if (command instanceof PutObjectCommand) throw { name: 'SignatureDoesNotMatch', message: credentials.secret_access_key, $metadata: { httpStatusCode: 403, requestId: credentials.api_token } };
      throw { name: credentials.secret_access_key, code: credentials.access_key_id, $metadata: { httpStatusCode: credentials.api_token } };
    }) as any);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let caught: any;
    try { await verifyR2(accountId, 'agency-media', credentials); } catch (error) { caught = error; }
    expect(caught?.diagnostic).toEqual({ step: 'write', provider_code: 'SignatureDoesNotMatch', http_status: 403, bucket: 'agency-media', account_id: accountId,
      cleanup_failure: { step: 'delete', provider_code: 'Unknown', http_status: null } });
    expect(caught?.message).toContain('Cleanup also failed');
    for (const secret of Object.values(credentials)) expect(JSON.stringify([caught, warning.mock.calls])).not.toContain(secret);
  });

  it('does not replace saved credentials after failed R2 verification or switch accounts during rotation', async () => {
    fakeS3();
    await connectCloudflare(session, { ...credentials, account_id: accountId, bucket: 'agency-media', revision: (await getConnection('default', 'cloudflare')).revision }, providerFetch());
    const original = await getConnection('default', 'cloudflare');
    fakeS3('read');
    await expect(connectCloudflare(session, { ...credentials, secret_access_key: 'synthetic-new-key', account_id: accountId, bucket: 'agency-media', revision: original.revision }, providerFetch())).rejects.toThrow('R2');
    expect((await getConnection('default', 'cloudflare')).encrypted_credentials).toBe(original.encrypted_credentials);
    const fetcher = providerFetch();
    await expect(connectCloudflare(session, { ...credentials, account_id: 'b'.repeat(32), bucket: 'agency-media', revision: original.revision }, fetcher)).rejects.toThrow('original Cloudflare account');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('explains missing and rejected upload keys without exposing credential values', async () => {
    await getConnection('default', 'cloudflare');
    await getStore().updateDoc(connectionPath('default', 'cloudflare'), { status: 'connected', auth_method: 'oauth',
      cloudflare: { account_id: accountId, bucket: 'agency-media', public_bucket: 'published-media' },
      encrypted_credentials: sealCredentials('default', 'cloudflare', { oauth: { access_token: 'synthetic-access', expires_at: Date.now() + 3600_000 } }) });
    const revision = (await getConnection('default', 'cloudflare')).revision;
    const s3 = fakeS3('put');
    const missing = await call(POST, routeContext('POST', 'cloudflare', { action: 'save_media', revision }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: 'r2_credentials_required', error: expect.stringContaining('both the Access Key ID and Secret Access Key') });
    expect(s3).not.toHaveBeenCalled();
    const invalid = await call(POST, routeContext('POST', 'cloudflare', { action: 'save_media', revision, ...credentials }));
    expect(invalid.status).toBe(502);
    const body = await invalid.json();
    expect(body).toMatchObject({ code: 'r2_verification_failed', error: expect.stringContaining('could not write a test file to bucket agency-media'), details: { step: 'write', provider_code: 'Unknown', http_status: null, account_id: accountId, bucket: 'agency-media' } });
    for (const secret of Object.values(credentials)) expect(JSON.stringify(body)).not.toContain(secret);
    expect((await getConnection('default', 'cloudflare')).media_ready).not.toBe(true);
  });

  it('binds ciphertext to its tenant and provider', () => {
    const encrypted = sealCredentials('default', 'cloudflare', credentials);
    expect(() => openCredentials('other', 'cloudflare', encrypted)).toThrow('could not be opened');
    expect(() => openCredentials('default', 'github', encrypted)).toThrow('could not be opened');
  });

  it('uses atomic account ownership claims', async () => {
    const results = await Promise.allSettled([claimAccount('one', 'github', '56'), claimAccount('two', 'github', '56')]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('rejects a wrong account and stale connection before persisting secrets', async () => {
    const s3 = fakeS3();
    const revision = (await getConnection('default', 'cloudflare')).revision;
    await expect(connectCloudflare(session, { ...credentials, account_id: accountId, bucket: 'agency-media', revision },
      providerFetch({ [`/client/v4/accounts/${accountId}`]: { success: true, result: { id: 'b'.repeat(32), name: 'Wrong account' } } }))).rejects.toThrow('verification failed');
    await disconnect('default', 'cloudflare', revision);
    await expect(connectCloudflare(session, { ...credentials, account_id: accountId, bucket: 'agency-media', revision }, providerFetch())).rejects.toThrow('changed');
    expect(s3).not.toHaveBeenCalled();
    expect((await getConnection('default', 'cloudflare')).encrypted_credentials).toBeNull();
  });
});

describe('publishing account routes', () => {
  it('rejects anonymous production callers', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await call(GET, routeContext())).status).toBe(401);
  });
  it.each(['editor', 'missing'])('denies %s even when legacy organization roles are not enforced', async (role) => {
    if (role === 'missing') await getStore().deleteDoc('organizations/default/members/dev-user');
    else await getStore().updateDoc('organizations/default/members/dev-user', { role });
    for (const route of [GET, POST, DELETE, CALLBACK, CLOUDFLARE_CALLBACK, GITHUB_PERMISSIONS]) expect((await call(route, routeContext())).status).toBe(403);
    for (const action of ['start', 'select', 'prepare_media', 'save_media']) expect((await call(POST, routeContext('POST', 'cloudflare', { action }))).status).toBe(403);
  });

  it('rejects signed-in users without an organization', async () => {
    vi.stubEnv('TYPEROLL_E2E_AUTH_SECRET', 'synthetic-e2e-test-key-with-at-least-32chars');
    const context = routeContext();
    context.cookies.get = vi.fn(() => ({ value: createE2ESessionCookie('pending') })) as any;
    expect((await call(GET, context)).status).toBe(403);
  });

  it('requires same-origin JSON, sets a private OAuth cookie and returns only the authorization URL', async () => {
    expect((await call(POST, routeContext('POST', 'github', { owner: 'synthetic-agency' }, 'https://elsewhere.test'))).status).toBe(403);
    const context = routeContext('POST', 'github', { owner: 'synthetic-agency' });
    const response = await call(POST, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(context.cookies.set.mock.calls[0]?.[2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/orgs/publishing/github' });
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['authorization_url']);
    expect(body.authorization_url).not.toContain('synthetic-client-secret');
  });

  it('starts Cloudflare OAuth without account input and rejects cross-origin requests', async () => {
    expect((await call(POST, routeContext('POST', 'cloudflare', { action: 'start' }, 'https://elsewhere.test'))).status).toBe(403);
    const context = routeContext('POST', 'cloudflare', { action: 'start' });
    const response = await call(POST, context);
    expect(response.status).toBe(200);
    expect(context.cookies.set.mock.calls[0]?.[2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/orgs/publishing/cloudflare' });
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['authorization_url']);
    expect(new URL(body.authorization_url).searchParams.get('code_challenge_method')).toBe('S256');
    expect(body.authorization_url).not.toContain('synthetic-cloudflare-secret');
    const callback = routeContext('GET', 'cloudflare');
    callback.url.search = '?code=synthetic-secret-code&state=invalid';
    const result = await call(CLOUDFLARE_CALLBACK, callback);
    expect(result.headers.get('location')).toBe('/app/settings/publishing?cloudflare=failed');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(callback.cookies.delete).toHaveBeenCalled();
  });

  it.each([null, [], true, 'not-an-object'])('rejects non-object connection input', async body => {
    expect((await call(POST, routeContext('POST', 'cloudflare', body))).status).toBe(400);
  });

  it('explains R2 activation without reflecting Cloudflare response text', async () => {
    const revision = (await getConnection('default', 'cloudflare')).revision;
    vi.stubGlobal('fetch', providerFetch({ [`/client/v4/accounts/${accountId}`]: Response.json({ errors: [{ code: 10042, message: 'synthetic-sensitive-reflection' }] }, { status: 403 }) }));
    const response = await call(POST, routeContext('POST', 'cloudflare', { ...credentials, account_id: accountId, bucket: 'agency-media', revision }));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('r2_activation_required');
    expect(text).toContain('R2 subscription checkout');
    expect(text).toContain('billing details');
    expect(text).toContain('I’ve activated R2 — check again');
    expect(text).not.toContain('synthetic-sensitive');
  });

  it('redacts provider errors and returns only the explicit public connection projection', async () => {
    const revision = (await getConnection('default', 'cloudflare')).revision;
    vi.stubGlobal('fetch', providerFetch({ [`/client/v4/accounts/${accountId}`]: new Response(credentials.api_token, { status: 403 }) }));
    const response = await call(POST, routeContext('POST', 'cloudflare', { ...credentials, account_id: accountId, bucket: 'agency-media', revision }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(credentials.api_token);
    await getStore().updateDoc(connectionPath('default', 'cloudflare'), { status: 'connected', encrypted_credentials: 'synthetic-ciphertext', unexpected_future_secret: 'synthetic-secret',
      cloudflare: { account_id: accountId, account_name: 'Synthetic account', bucket: 'agency-media', public_bucket: 'public-media', endpoint: 'https://example.test', unexpected_future_secret: 'synthetic-nested-secret' } });
    const summary = await call(GET, routeContext());
    const body = await summary.text();
    expect(body).not.toContain('synthetic-secret'); expect(body).not.toContain('synthetic-ciphertext');
    expect(body).not.toContain('synthetic-nested-secret');
  });

  it('rejects oversized requests and discards OAuth callback inputs from the redirect', async () => {
    expect((await call(POST, routeContext('POST', 'cloudflare', { token: 'x'.repeat(9000) }))).status).toBe(413);
    const context = routeContext();
    context.url.search = '?code=synthetic-sensitive-code&state=untrusted&installation_id=34';
    const result = await call(CALLBACK, context);
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/app/settings/publishing?github=failed');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(context.cookies.delete).toHaveBeenCalled();
  });
});


describe('existing GitHub installation permission updates', () => {
  it('distinguishes publisher setup from owner approval and confirms live grants without reconnecting', async () => {
    await finishGithubConnection(session, await authorization(), providerFetch());
    const before = await getConnection('default', 'github');
    const fetcher = providerFetch({ '/app': { id: 12, permissions: installation.permissions } });
    expect(await checkGithubPermissions('default', fetcher)).toMatchObject({
      state: 'publisher_update_required', approval_url: null, missing_permissions: ['actions', 'workflows'],
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual(['/app', '/app/installations/34']);
    const requested = { ...installation.permissions, actions: 'write', workflows: 'write' };
    expect(await checkGithubPermissions('default', providerFetch({ '/app': { id: 12, permissions: requested } }))).toMatchObject({
      state: 'approval_required', approval_url: 'https://github.com/organizations/synthetic-agency/settings/installations/34',
    });
    vi.stubGlobal('fetch', providerFetch({ '/app': { id: 12, permissions: requested }, '/app/installations/34': { ...installation, permissions: requested } }));
    const response = await call(GITHUB_PERMISSIONS, routeContext());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ state: 'up_to_date', approval_url: null, missing_permissions: [], revision: before.revision });
    expect(await getConnection('default', 'github')).toEqual(before);
  });

  it.each([
    { '/app': { id: 999 } },
    { '/app/installations/34': { ...installation, account: { ...installation.account, id: 999 } } },
    { '/app/installations/34': { ...installation, suspended_at: '2026-09-09' } },
  ])('rejects changed or suspended provider authority', async (overrides) => {
    await finishGithubConnection(session, await authorization(), providerFetch());
    await expect(checkGithubPermissions('default', providerFetch({ '/app': { id: 12 }, ...overrides }))).rejects.toThrow();
  });

  it('rejects a check completed after the connection was replaced', async () => {
    await finishGithubConnection(session, await authorization(), providerFetch());
    const fetcher = providerFetch({ '/app': { id: 12 } });
    const replacement = vi.fn<typeof fetch>(async (url, init) => {
      if (new URL(String(url)).pathname === '/app') await getStore().updateDoc(connectionPath('default', 'github'), { revision: 'replacement' });
      return fetcher(url, init);
    });
    await expect(checkGithubPermissions('default', replacement)).rejects.toThrow('connection changed');
  });
});
