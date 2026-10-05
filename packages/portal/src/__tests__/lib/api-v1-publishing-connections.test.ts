// Public-API organization publishing connections:
//   GET    /api/v1/publishing/connections
//   POST   /api/v1/publishing/connections/cloudflare   (browserless steps)
//   DELETE /api/v1/publishing/connections/{provider}
// Organization keys only, as the portal Publishing page is for organization
// owners and admins. OAuth sign-in stays in the browser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'owner-org';
const SITE = 'main-site';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://portal.test');
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'Main', created_at: '2026-01-01' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function key(siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId: ORG, siteId, name: 'seed', createdBy: 'person@example.test' })).token;
}

async function call(method: string, token: string, params: Record<string, string>, body?: unknown) {
  const mod = (params.provider
    ? await import('../../pages/api/v1/publishing/connections/[provider]')
    : await import('../../pages/api/v1/publishing/connections/index')) as Record<string, APIRoute>;
  const res = await mod[method]!({
    request: new Request('https://portal.test/api/v1/publishing/connections', {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params,
  } as never) as Response;
  return { status: res.status, json: await res.json().catch(() => ({})) as any, headers: res.headers };
}

describe('organization publishing connections through the public API', () => {
  it('reads status and connect URLs without exposing credentials', async () => {
    const { getConnection, saveConnection, sealCredentials } = await import('../../lib/publishing/connections');
    const current = await getConnection(ORG, 'github');
    await saveConnection(ORG, 'github', current.revision, {
      status: 'connected', github: { app_id: '1', installation_id: '2', account_id: '3', owner: 'synthetic-owner' },
      encrypted_credentials: sealCredentials(ORG, 'github', { token: 'synthetic-secret-token' }),
    });
    const res = await call('GET', await key(null), {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.json.github).toMatchObject({ status: 'connected', github: { owner: 'synthetic-owner' } });
    expect(res.json.cloudflare.status).toBe('disconnected');
    expect(res.json.connect_urls).toEqual({
      github: 'https://portal.test/app/settings/publishing#github',
      cloudflare: 'https://portal.test/app/settings/publishing#cloudflare',
    });
    expect(JSON.stringify(res.json)).not.toContain('synthetic-secret-token');
    expect(JSON.stringify(res.json)).not.toContain('encrypted_credentials');
  });

  it('refuses site-scoped keys, as the portal refuses site administrators', async () => {
    const siteKey = await key(SITE);
    expect((await call('GET', siteKey, {})).status).toBe(403);
    expect((await call('DELETE', siteKey, { provider: 'github' }, { revision: 'x' })).status).toBe(403);
    expect((await call('POST', siteKey, { provider: 'cloudflare' }, { action: 'prepare_media', revision: 'x' })).status).toBe(403);
  });

  it('disconnects only at the current revision', async () => {
    const { getConnection, saveConnection } = await import('../../lib/publishing/connections');
    const current = await getConnection(ORG, 'github');
    await saveConnection(ORG, 'github', current.revision, { status: 'connected' });
    const token = await key(null);
    expect((await call('DELETE', token, { provider: 'github' }, { revision: current.revision })).status).toBe(409);
    const latest = await getConnection(ORG, 'github');
    const res = await call('DELETE', token, { provider: 'github' }, { revision: latest.revision });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ disconnected: true });
    expect((await getConnection(ORG, 'github')).status).toBe('disconnected');
    expect((await call('DELETE', token, { provider: 'gitlab' }, { revision: 'x' })).status).toBe(404);
  });

  it('points browser-only steps at the portal and validates Cloudflare actions', async () => {
    const token = await key(null);
    const github = await call('POST', token, { provider: 'github' }, {});
    expect(github.status).toBe(409);
    expect(github.json.error).toContain('https://portal.test/app/settings/publishing#github');
    // The refusal says who must do what next; here the publisher has not configured its App.
    expect(github.json.connect_url).toBe('https://portal.test/app/settings/publishing#github');
    expect(github.json.diagnosis).toMatchObject({ outcome: 'unavailable', blockers: [expect.objectContaining({ code: 'publisher_app_misconfigured', who: 'publisher' })] });
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'start' })).status).toBe(400);
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'connect', revision: 'x' })).status).toBe(400);
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'prepare_media', revision: 'x' })).status).toBe(409);
    expect((await call('POST', token, { provider: 'cloudflare' }, { action: 'connect', hosting_group_id: 'eu' })).status).toBe(400);
  });

  it('connects Cloudflare with a customer API token and records the key as the actor', async () => {
    const accountId = 'a'.repeat(32);
    const cloudflare = await import('../../lib/publishing/cloudflare-connection');
    const spy = vi.spyOn(cloudflare, 'connectCloudflare').mockResolvedValue(undefined);
    const token = await key(null);
    const body = { action: 'connect', revision: 'r', account_id: accountId, bucket: 'media', api_token: 't', access_key_id: 'a', secret_access_key: 's' };
    const res = await call('POST', token, { provider: 'cloudflare' }, body);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ connected: true });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, userId: expect.stringMatching(/^api-key:[a-f0-9]{12}$/) }), body);
  });
});

describe('GitHub connection diagnosis through the public API', () => {
  async function diagnose(token: string, search = '') {
    const { GET } = await import('../../pages/api/v1/publishing/github-diagnosis');
    const res = await GET({ request: new Request(`https://portal.test/api/v1/publishing/github-diagnosis${search}`, { headers: { authorization: `Bearer ${token}` } }) } as never) as Response;
    return { status: res.status, json: await res.json() as any, headers: res.headers };
  }

  it('returns the organization diagnosis to organization keys only', async () => {
    expect((await diagnose(await key(SITE))).status).toBe(403);
    const res = await diagnose(await key(null));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.json.connect_url).toBe('https://portal.test/app/settings/publishing#github');
    expect(res.json.diagnosis).toMatchObject({ version: 1, outcome: 'unavailable', installations: [] });
  });

  it('re-checks the connected installation with App authority and returns no secrets', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    for (const [name, value] of Object.entries({ TYPEROLL_PUBLISH_GITHUB_APP_ID: '12', TYPEROLL_PUBLISH_GITHUB_CLIENT_ID: 'synthetic-client',
      TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET: 'synthetic-client-secret', TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY: privateKey, TYPEROLL_PUBLISH_GITHUB_APP_SLUG: 'synthetic-publisher' })) vi.stubEnv(name, value);
    const { getConnection, saveConnection } = await import('../../lib/publishing/connections');
    await saveConnection(ORG, 'github', (await getConnection(ORG, 'github')).revision, {
      status: 'connected', github: { app_id: '12', installation_id: '34', account_id: '56', owner: 'synthetic-org' } });
    const installation = { id: 34, app_id: 12, account: { id: 56, login: 'synthetic-org', type: 'Organization' }, repository_selection: 'selected', suspended_at: null,
      permissions: { contents: 'write', administration: 'write', members: 'read' } };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/app/installations/34' ? Response.json(installation) : new Response('{}', { status: 404 })));
    const res = await diagnose(await key(null), '?recheck=true');
    expect(res.status).toBe(200);
    expect(res.json.diagnosis).toMatchObject({ outcome: 'needs_attention', attempted_by: null, github_user: null,
      installations: [expect.objectContaining({ installation_id: '34', blockers: [expect.objectContaining({ code: 'repository_selection_limited',
        action: expect.objectContaining({ url: 'https://github.com/organizations/synthetic-org/settings/installations/34' }) })] })] });
    expect(JSON.stringify(res.json)).not.toMatch(/synthetic-client-secret|PRIVATE KEY/);
    vi.unstubAllGlobals();
  });

  it('never returns a person’s unfinished attempt, only the organization’s state', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    for (const [name, value] of Object.entries({ TYPEROLL_PUBLISH_GITHUB_APP_ID: '12', TYPEROLL_PUBLISH_GITHUB_CLIENT_ID: 'synthetic-client',
      TYPEROLL_PUBLISH_GITHUB_CLIENT_SECRET: 'synthetic-client-secret', TYPEROLL_PUBLISH_GITHUB_PRIVATE_KEY: privateKey, TYPEROLL_PUBLISH_GITHUB_APP_SLUG: 'synthetic-publisher' })) vi.stubEnv(name, value);
    const { getConnection } = await import('../../lib/publishing/connections');
    const { composeDiagnosis, githubBlocker, recordGithubDiagnosis } = await import('../../lib/publishing/github-diagnosis');
    const account = { login: 'private-org', type: 'Organization' as const, id: '57' };
    const person = { id: '78', login: 'synthetic-person' };
    await recordGithubDiagnosis(ORG, composeDiagnosis({ revision: (await getConnection(ORG, 'github')).revision, attemptedBy: 'person-user-id', githubUser: person,
      blockers: [githubBlocker('sso_authorization_required', { ssoUrl: 'https://github.com/orgs/private-org/sso?authorization_request=synthetic' }), githubBlocker('no_installation')],
      installations: [{ installation_id: '35', account, usable: false, blockers: [githubBlocker('not_org_owner', { account, installationId: '35', user: person })] }] }),
    { userId: 'person-user-id', identity: { user: person, verifiedAt: Date.now() } });
    const token = await key(null);
    for (const diagnosis of [(await diagnose(token)).json.diagnosis, (await call('POST', token, { provider: 'github' }, {})).json.diagnosis]) {
      expect(diagnosis).toMatchObject({ outcome: 'action_required', github_user: null, attempted_by: null, installations: [], primary_action: { kind: 'install' } });
      expect(JSON.stringify(diagnosis)).not.toMatch(/synthetic-person|person-user-id|private-org|authorization_request/);
    }
  });

  it('answers a failed status read with an error response', async () => {
    const token = await key(null);
    const { getStore } = await import('../../lib/datastore');
    vi.spyOn(getStore(), 'createDocIfMissing').mockRejectedValue(new Error('synthetic store failure'));
    const github = await call('POST', token, { provider: 'github' }, {});
    expect(github.status).toBe(502);
    expect(JSON.stringify(github.json)).not.toContain('synthetic store failure');
  });
});

describe('Cloudflare connection diagnosis through the public API', () => {
  async function diagnose(token: string, search = '') {
    const { GET } = await import('../../pages/api/v1/publishing/cloudflare-diagnosis');
    const res = await GET({ request: new Request(`https://portal.test/api/v1/publishing/cloudflare-diagnosis${search}`, { headers: { authorization: `Bearer ${token}` } }) } as never) as Response;
    return { status: res.status, json: await res.json() as any, headers: res.headers };
  }
  const configure = () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-client-secret');
  };

  it('returns a Hosting Group’s diagnosis to organization keys only', async () => {
    expect((await diagnose(await key(SITE))).status).toBe(403);
    const token = await key(null);
    const res = await diagnose(token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.json.connect_url).toBe('https://portal.test/app/settings/publishing#cloudflare');
    expect(res.json.diagnosis).toMatchObject({ version: 1, hosting_group_id: 'default', outcome: 'unavailable', blockers: [{ code: 'publisher_oauth_misconfigured', who: 'publisher' }] });
    const { saveHostingGroup } = await import('../../lib/publishing/hosting-groups');
    const group = await saveHostingGroup(ORG, { name: 'Hosting 2', sites_domain: null, dns_mode: 'external' });
    configure();
    const grouped = await diagnose(token, `?hosting_group=${group.id}`);
    expect(grouped.json).toMatchObject({ connect_url: `https://portal.test/app/settings/publishing#hosting-${group.id}`, diagnosis: { hosting_group_id: group.id, outcome: 'sign_in_required' } });
    expect((await diagnose(token, '?hosting_group=missing-group')).status).toBe(404);
    expect((await diagnose(token, '?hosting_group=Not%20valid')).status).toBe(400);
  });

  it('re-checks a saved connection with its own authorization and never returns a person’s attempt', async () => {
    configure();
    const { getConnection, saveConnection, sealCredentials } = await import('../../lib/publishing/connections');
    const { composeCloudflareDiagnosis, cloudflareBlocker, recordCloudflareDiagnosis } = await import('../../lib/publishing/cloudflare-diagnosis');
    const account = { id: 'c'.repeat(32), name: 'Private personal account' };
    await recordCloudflareDiagnosis(ORG, composeCloudflareDiagnosis({ groupId: 'default', revision: (await getConnection(ORG, 'cloudflare')).revision, attemptedBy: 'person-user-id',
      accounts: [{ ...account, usable: false, blockers: [cloudflareBlocker('pages_access_denied', { account })] }] }), { userId: 'person-user-id', consentedAt: Date.now() });
    const token = await key(null);
    const attempt = (await diagnose(token)).json.diagnosis;
    expect(attempt).toMatchObject({ outcome: 'action_required', attempted_by: null, accounts: [], recheck_available: false, blockers: [{ code: 'pages_access_denied' }] });
    expect(JSON.stringify(attempt)).not.toMatch(/person-user-id|Private personal account|c{32}/);
    const saved = { id: 'd'.repeat(32), name: 'Organization account' };
    await saveConnection(ORG, 'cloudflare', (await getConnection(ORG, 'cloudflare')).revision, { status: 'connected', auth_method: 'api_token',
      cloudflare: { account_id: saved.id, account_name: saved.name, bucket: '', endpoint: '' }, encrypted_credentials: sealCredentials(ORG, 'cloudflare', { api_token: 'synthetic-api-token' }) });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === `/client/v4/accounts/${saved.id}`) return Response.json({ success: true, result: saved });
      return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 });
    }));
    const res = await diagnose(token, '?recheck=true');
    expect(res.json.diagnosis).toMatchObject({ outcome: 'needs_attention', attempted_by: null,
      accounts: [{ id: saved.id, usable: false, blockers: [{ code: 'pages_access_denied', who: 'cloudflare_account_admin' }] }] });
    expect(JSON.stringify(res.json)).not.toMatch(/synthetic-api-token|synthetic-client-secret/);
    vi.unstubAllGlobals();
  });
});
