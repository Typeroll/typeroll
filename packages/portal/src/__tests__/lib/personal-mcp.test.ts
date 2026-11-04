import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createPersonalConnection, verifyApiToken, revokePersonalConnection } from '../../lib/api-keys';
import { rememberOrganization } from '../../lib/organization-session';
import { personalSites } from '../../lib/personal-site-access';
import { requireAnyApiKey, requireApiKey } from '../../lib/api-auth';
import { issueSiteContext, verifySiteContext } from '../../lib/mcp-site-context';
import { POST as hosted } from '../../pages/api/mcp/index';
import { GET as resolvePage } from '../../pages/api/v1/sites/[siteId]/resolve-page';
import { POST as complete } from '../../pages/api/mcp/oauth/complete';
import { signClientId, exchangeAuthorizationCode } from '../../lib/mcp-tokens';
import crypto from 'node:crypto';

const account = vi.hoisted(() => ({ configured: false, getUser: vi.fn() }));
vi.mock('../../lib/firebase-admin', () => ({ isFirebaseAdminConfigured: () => account.configured, getFirebaseAdminApp: async () => ({}) }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ getUser: account.getUser }) }));
vi.mock('../../lib/auth', () => ({ getSession: async () => ({ userId: 'person', email: 'person@example.test', orgId: 'alpha' }) }));
let token: string;
let prefix: string;
const origin = 'https://portal.test';
async function seedOrg(id: string, role: string) {
  const store = getStore();
  await store.setDoc(paths.org(id), { name: id, roles_enforced: true });
  await store.setDoc(`${paths.members(id)}/person`, { role });
  await store.setDoc(paths.site(id, 'same-id'), { name: `${id} Site`, domain: `${id}.example.test` });
  await rememberOrganization('person', id);
}
function request(path: string, org?: string, method = 'GET') {
  return new Request(`${origin}/api/v1/${path}`, { method, headers: {
    authorization: `Bearer ${token}`, ...(org ? { 'Typeroll-Organization': org } : {}),
  } });
}
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await hosted({ request: new Request(`${origin}/api/mcp?tools=full`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }) } as never) as Response;
  const body = await response.json();
  return body.result;
}
beforeEach(async () => {
  account.configured = false; account.getUser.mockReset();
  makeTmpFixtures(); await resetDatastore();
  process.env.PORTAL_PUBLIC_URL = origin;
  process.env.MCP_OAUTH_SIGNING_KEY = 'synthetic-personal-mcp-signing-key-32-characters';
  await seedOrg('alpha', 'editor'); await seedOrg('beta', 'owner');
  ({ token, prefix } = await createPersonalConnection('person', 'Test connector'));
});

describe('personal authorization', () => {
  it('accepts editor consent without an organization/site grant or administrator key', async () => {
    const callback = 'https://client.test/callback';
    const clientId = signClientId([callback]);
    const verifier = 'synthetic-personal-verifier-with-at-least-43-characters';
    const response = await complete({ request: new Request(`${origin}/api/mcp/oauth/complete`, {
      method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ decision: 'allow', client_id: clientId, redirect_uri: callback,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }),
    }) } as never) as Response;
    expect(response.status).toBe(302);
    const credential = await exchangeAuthorizationCode({ code: new URL(response.headers.get('location')!).searchParams.get('code')!,
      audience: `${origin}/api/mcp`, redirectUri: callback, codeVerifier: verifier, clientId });
    expect(await verifyApiToken(credential!)).toMatchObject({ personalUserId: 'person', orgId: '', siteId: null });
  });

  it('distinguishes equal site IDs and follows membership, new access and demotion live', async () => {
    expect((await personalSites('person')).map(site => [site.ownerOrgId, site.permission])).toEqual([['alpha', 'write'], ['beta', 'admin']]);
    expect((await requireApiKey(request('sites/same-id/pages', 'alpha', 'POST'), 'same-id')).ok).toBe(true);
    await getStore().deleteDoc(`${paths.members('alpha')}/person`);
    expect((await requireApiKey(request('sites/same-id/pages', 'alpha'), 'same-id')).ok).toBe(false);
    await getStore().setDoc(`${paths.members('beta')}/person`, { role: 'editor' });
    const beta = await requireApiKey(request('sites/same-id/pages', 'beta'), 'same-id');
    expect(beta.ok && beta.value.permission).toBe('write');
    await seedOrg('gamma', 'editor');
    expect((await personalSites('person')).map(site => site.ownerOrgId)).toEqual(['beta', 'gamma']);
  });

  it('requires explicit organization and refuses editor organization administration', async () => {
    expect((await requireApiKey(request('sites/same-id/pages'), 'same-id')).ok).toBe(false);
    expect((await requireAnyApiKey(request('sites'))).ok).toBe(true);
    for (const route of ['sites', 'organization/api-keys', 'publishing/connections']) {
      expect((await requireAnyApiKey(request(route, 'alpha', 'POST'))).ok).toBe(false);
      expect((await requireAnyApiKey(request(route, undefined, 'POST'))).ok).toBe(false);
    }
    expect((await requireAnyApiKey(request('sites', 'beta', 'POST'))).ok).toBe(true);
  });

  it('allows only the connection owner to revoke, and revocation invalidates every subsequent call', async () => {
    expect(await revokePersonalConnection('another-person', prefix)).toBe(false);
    expect(await verifyApiToken(token)).not.toBeNull();
    expect(await revokePersonalConnection('person', prefix)).toBe(true);
    expect(await verifyApiToken(token)).toBeNull();
    expect((await requireAnyApiKey(request('sites'))).ok).toBe(false);
  });
});

describe('stateless site selection', () => {
  it('binds context to connection, site, organization and version, with expiration', () => {
    const site = { organizationId: 'alpha', siteId: 'same-id', version: 'main' };
    const context = issueSiteContext(site, token);
    expect(verifySiteContext(context, token)).toEqual(site);
    expect(verifySiteContext(context, 'another-connection')).toBeNull();
    expect(verifySiteContext(context.split('.')[0] + '.' + 'é'.repeat(43), token)).toBeNull();
    expect(verifySiteContext(context.replace(/^./, context[0] === 'a' ? 'b' : 'a'), token)).toBeNull();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000);
    expect(verifySiteContext(context, token)).toBeNull(); spy.mockRestore();
  });

  it('requires selection in the real hosted route and keeps parallel conversations independent', async () => {
    expect((await callTool('get_site')).isError).toBe(true);
    const selected = await callTool('select_site', { organization_id: 'alpha', site_id: 'same-id', version: 'main' });
    const alpha = JSON.parse(selected.content[0].text);
    const beta = JSON.parse((await callTool('select_site', { organization_id: 'beta', site_id: 'same-id', version: 'main' })).content[0].text);
    expect(verifySiteContext(alpha.site_context, token)?.organizationId).toBe('alpha');
    expect(verifySiteContext(beta.site_context, token)?.organizationId).toBe('beta');
    expect((await callTool('select_site', { organization_id: 'alpha', site_id: 'same-id', version: 'missing' })).isError).toBe(true);
    await getStore().deleteDoc(`${paths.members('alpha')}/person`);
    expect((await callTool('get_site', { site_context: alpha.site_context })).isError).toBe(true);
  });
});

it('resolves stored routes only within the selected site, including content types and fragments', async () => {
  await getStore().setDoc(paths.contentType('alpha', 'same-id', 'article', 'main'), { name: 'article', route_template: '/articles/{slug}', fields: [] });
  await getStore().setDoc(paths.page('alpha', 'same-id', 'hello', 'main'), { title: 'Hello', slug: 'hello', content_type: 'article', status: 'draft' });
  const resolve = (url: string) => resolvePage({ request: request(`sites/same-id/resolve-page?url=${encodeURIComponent(url)}`, 'alpha'), params: { siteId: 'same-id' } } as never) as Promise<Response>;
  const response = await resolve('https://alpha.example.test/articles/hello/#details');
  expect(await response.json()).toMatchObject({ pages: [{ id: 'hello', status: 'draft' }], fragment: '#details' });
  expect((await resolve('https://beta.example.test/articles/hello/')).status).toBe(409);
});


it('keeps read-only site shares read-only and checks canonical revocation even with a stale index', async () => {
  const { writeShare } = await import('../../lib/shares');
  await getStore().setDoc(paths.site('outside', 'shared-site'), { name: 'Shared' });
  await writeShare({ id: 'share-test', owner_org_id: 'outside', site_id: 'shared-site', shared_with_org_id: 'alpha', permission: 'read', created_at: Date.now(), created_by: 'synthetic' });
  const read = await requireApiKey(request('sites/shared-site/pages', 'outside'), 'shared-site');
  expect(read.ok && read.value.permission).toBe('read');
  expect((await requireApiKey(request('sites/shared-site/block-types', 'outside', 'POST'), 'shared-site')).ok).toBe(false);
  await getStore().updateDoc(paths.share('outside', 'shared-site', 'share-test'), { revoked_at: Date.now() });
  expect((await personalSites('person')).some(site => site.ownerOrgId === 'outside')).toBe(false);
  expect((await requireApiKey(request('sites/shared-site/pages', 'outside'), 'shared-site')).ok).toBe(false);
});

it('keeps a connection until it is revoked, renews refresh and revokes a replayed refresh chain', async () => {
  const { issueToken, verifyToken } = await import('../../lib/mcp-tokens');
  const { POST: exchange } = await import('../../pages/api/mcp/oauth/token');
  const audience = `${origin}/api/mcp`;
  const clientId = signClientId(['https://client.test/callback']);
  // A connection approved long ago keeps working.
  const old = await createPersonalConnection('person', 'Old');
  await getStore().updateDoc(paths.apiKeyLookupEntry(old.prefix), { oauth_created_at: new Date(Date.now() - 400 * 86400000).toISOString() });
  expect(await verifyApiToken(old.token)).not.toBeNull();
  // A refresh token close to its end gets a full new lifetime on rotation.
  const refresh = issueToken({ apiKey: token, audience, kind: 'refresh', clientId, expiresAt: Math.floor(Date.now() / 1000) + 60 });
  const redeem = () => exchange({ request: new Request(`${origin}/api/mcp/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh.token, client_id: clientId }),
  }) } as never) as Promise<Response>;
  const first = await redeem();
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  const rotated = verifyToken(firstBody.refresh_token, audience);
  expect(rotated!.exp - Date.now() / 1000).toBeGreaterThan(50 * 365 * 86400);
  // The rotated token works once more; the chain head moved with it.
  const next = await exchange({ request: new Request(`${origin}/api/mcp/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: firstBody.refresh_token, client_id: clientId }),
  }) } as never) as Response;
  expect(next.status).toBe(200);
  // Replaying the used refresh token revokes the connection and says why.
  const replay = await redeem();
  expect(replay.status).toBe(400);
  expect((await replay.json()).error_description).toMatch(/used twice.*Reconnect Typeroll/);
  expect(await verifyApiToken(token)).toBeNull();
});

it('allows personal editor block authoring but keeps site instructions administrator-managed and versioned', async () => {
  const { POST: createBlockType } = await import('../../pages/api/v1/sites/[siteId]/block-types/index');
  const { PATCH: updateSettings, GET: readSettings } = await import('../../pages/api/v1/sites/[siteId]/settings');
  const mutate = (path: string, org: string, body: unknown, method = 'PATCH') => new Request(`${origin}/api/v1/sites/same-id/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'Typeroll-Organization': org, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const created = await createBlockType({ params: { siteId: 'same-id' }, request: mutate('block-types', 'alpha', {
    name: 'editor_notice', label: 'Notice', schema: [{ name: 'text', type: 'text', label: 'Text' }], template: '<p>{{text}}</p>',
  }, 'POST') } as never) as Response;
  expect(created.status, await created.clone().text()).toBe(200);
  const save = (org: string, instructions: unknown, query = '') => updateSettings({ params: { siteId: 'same-id' }, request: mutate(`settings${query}`, org, { agent_instructions: instructions }) } as never) as Promise<Response>;
  expect((await save('alpha', 'Guidance')).status).toBe(403);
  expect((await save('beta', 'x'.repeat(12001))).status).toBe(400);
  expect((await save('beta', { unsafe: 'object' })).status).toBe(400);
  expect((await save('beta', 'Use clear language.')).status).toBe(200);
  await getStore().setDoc(paths.version('beta', 'same-id', 'experiment'), { name: 'Experiment', parent_version_id: 'main', created_at: new Date().toISOString() });
  expect((await save('beta', 'Use concise language.', '?version=experiment')).status).toBe(200);
  const main = await readSettings({ params: { siteId: 'same-id' }, request: request('sites/same-id/settings', 'beta') } as never) as Response;
  expect((await main.json()).settings.agent_instructions).toBe('Use clear language.');
});

it('fails closed for disabled, deleted or revoked user accounts and provider failures', async () => {
  account.configured = true;
  account.getUser.mockResolvedValue({ disabled: false, emailVerified: true, tokensValidAfterTime: '2020-01-01T00:00:00Z' });
  expect(await verifyApiToken(token)).toMatchObject({ personalUserId: 'person' });
  account.getUser.mockResolvedValue({ disabled: false, emailVerified: false, tokensValidAfterTime: '2020-01-01T00:00:00Z' });
  expect(await verifyApiToken(token)).toBeNull();
  account.getUser.mockResolvedValue({ disabled: false, tokensValidAfterTime: '2020-01-01T00:00:00Z' });
  expect(await verifyApiToken(token)).toBeNull();
  account.getUser.mockResolvedValue({ disabled: true, emailVerified: true });
  expect(await verifyApiToken(token)).toBeNull();
  account.getUser.mockResolvedValue({ disabled: false, emailVerified: true, tokensValidAfterTime: new Date(Date.now() + 1000).toISOString() });
  expect(await verifyApiToken(token)).toBeNull();
  for (const code of ['auth/user-not-found', 'auth/internal-error']) {
    account.getUser.mockRejectedValue(Object.assign(new Error('Synthetic account lookup failure'), { code }));
    expect(await verifyApiToken(token)).toBeNull();
  }
});

it('requires owning organization admin access for a personal connection to approve zone cache recovery', async () => {
  const { POST } = await import('../../pages/api/v1/sites/[siteId]/deploy');
  const invoke = (org: string) => POST({ params: { siteId: 'same-id' }, request: new Request(`${origin}/api/v1/sites/same-id/deploy`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'Typeroll-Organization': org, 'content-type': 'application/json' },
    body: JSON.stringify({ retry_verification_job_id: 'missing', approve_cache_zone_id: 'zone' }),
  }) } as never) as Promise<Response>;
  expect((await invoke('alpha')).status).toBe(403);
  expect((await invoke('beta')).status).toBe(404); // owning admin passes auth, job is absent
  await getStore().setDoc(paths.share('alpha', 'same-id', 'grant'), { owner_org_id: 'alpha', site_id: 'same-id', shared_with_org_id: 'beta', permission: 'admin' });
  await getStore().setDoc(paths.sharesWithOrgEntry('beta', 'grant'), { owner_org_id: 'alpha', site_id: 'same-id' });
  // A site share grants publication rights, never control of the owner's DNS zone.
  expect((await requireApiKey(request('sites/same-id/deploy', 'alpha', 'POST'), 'same-id')).ok).toBe(true);
  expect((await invoke('alpha')).status).toBe(403);
});

it('creates a personal API token that reaches every organization through the header', async () => {
  const { POST: createToken } = await import('../../pages/api/account/api-tokens');
  const portal = new URL(process.env.PORTAL_PUBLIC_URL || origin).origin;
  const created = await createToken({ request: new Request(`${portal}/api/account/api-tokens`, {
    method: 'POST', headers: { origin: portal, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Report script' }),
  }), cookies: {} } as never) as Response;
  expect(created.status).toBe(201);
  const { token: apiToken, name } = await created.json();
  expect(name).toBe('Report script');
  const { listPersonalConnections } = await import('../../lib/api-keys');
  expect((await listPersonalConnections('person')).find(entry => entry.name === 'Report script')?.kind).toBe('api_token');
  const { GET: organizations } = await import('../../pages/api/v1/organizations');
  const listed = await organizations({ request: new Request(`${origin}/api/v1/organizations`, { headers: { authorization: `Bearer ${apiToken}` } }) } as never) as Response;
  expect(listed.status).toBe(200);
  expect((await listed.json()).organizations.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining(['alpha', 'beta']));
  // A site call needs the organization named in the header.
  const site = (organization?: string) => requireApiKey(new Request(`${origin}/api/v1/sites/same-id/pages`, {
    headers: { authorization: `Bearer ${apiToken}`, ...(organization ? { 'Typeroll-Organization': organization } : {}) },
  }), 'same-id');
  expect((await site()).ok).toBe(false);
  expect((await site('alpha')).ok).toBe(true);
});

it('limits a personal API token to chosen organizations, to reads and to its expiry', async () => {
  const { POST: createToken } = await import('../../pages/api/account/api-tokens');
  const portal = new URL(process.env.PORTAL_PUBLIC_URL || origin).origin;
  const create = (body: unknown) => createToken({ request: new Request(`${portal}/api/account/api-tokens`, {
    method: 'POST', headers: { origin: portal, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), cookies: {} } as never) as Promise<Response>;
  expect((await create({ name: 'Bad', organization_ids: ['not-mine'] })).status).toBe(400);
  expect((await create({ name: 'Bad', expires_in_days: 7 })).status).toBe(400);
  const limited = await create({ name: 'Alpha reader', organization_ids: ['alpha'], read_only: true, expires_in_days: 30 });
  expect(limited.status).toBe(201);
  const { token: limitedToken, expires_at } = await limited.json();
  expect(Date.parse(expires_at)).toBeGreaterThan(Date.now() + 29 * 86400000);
  const call = (method: string, organization: string) => requireApiKey(new Request(`${origin}/api/v1/sites/same-id/pages`, {
    method, headers: { authorization: `Bearer ${limitedToken}`, 'Typeroll-Organization': organization },
  }), 'same-id');
  const read = await call('GET', 'alpha');
  expect(read.ok && read.value.permission).toBe('read');
  expect((await call('PATCH', 'alpha')).ok).toBe(false);
  const other = await call('GET', 'beta');
  expect(other.ok).toBe(false);
  if (!other.ok) expect((await other.response.json()).code).toBe('token_organization_not_allowed');
  // Discovery lists only the allowed organization and ignores the header.
  const { GET: organizations } = await import('../../pages/api/v1/organizations');
  const listed = await organizations({ request: new Request(`${origin}/api/v1/organizations`, {
    headers: { authorization: `Bearer ${limitedToken}`, 'Typeroll-Organization': 'beta' },
  }) } as never) as Response;
  expect((await listed.json()).organizations.map((entry: { id: string }) => entry.id)).toEqual(['alpha']);
  // An expired token stops working.
  const { paths: sharedPaths } = await import('@typeroll/shared');
  const lookups = await getStore().listDocs<{ id: string; personal_user_id?: string; expires_at?: string }>('api_key_lookup');
  const entry = lookups.find(doc => doc.expires_at);
  expect(entry).toBeTruthy();
  await getStore().updateDoc(sharedPaths.apiKeyLookupEntry(entry!.id), { expires_at: new Date(Date.now() - 1000).toISOString() });
  expect(await verifyApiToken(limitedToken)).toBeNull();
});

