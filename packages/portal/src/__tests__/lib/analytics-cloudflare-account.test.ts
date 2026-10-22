// Analytics (Cloudflare Web Analytics) lives in, and is read from, the
// Cloudflare account that hosts the site: the Organization's Hosting Group
// account for customer publishing, the installation's account for managed and
// self-hosted sites. Every Cloudflare call here is mocked; the installation's
// account is configured in every test so that any fallback to it is caught.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths, type Site, type SiteApps } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'orgone';
const SITE = 'shop';
const ORG_ACCOUNT = 'a'.repeat(32);
const GROUP_ACCOUNT = 'b'.repeat(32);
const PLATFORM_ACCOUNT = 'c'.repeat(32);
const ORG_TAG = '1'.repeat(32);
const ORG_TOKEN = '2'.repeat(32);
const ANALYTICS_SCOPES = 'account-settings.read page.read page.write workers-r2.read workers-r2.write offline_access account-settings.write account-analytics.read';
const BASE_SCOPES = 'account-settings.read page.read page.write workers-r2.read workers-r2.write offline_access';

interface Call { url: string; method: string; auth: string | null; body: any }

/** A Cloudflare double: records every call and answers from `handler`, defaulting to 404. */
function cloudflare(handler: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const call: Call = {
      url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call) ?? Response.json({ success: false, errors: [{ code: 7003 }] }, { status: 404 });
  });
  return { calls, fetchImpl };
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) => Response.json({ success: true, errors: [], result, ...extra });
const site = (tag: string, token: string, host: string) => ({ site_tag: tag, site_token: token, rules: [{ host }], snippet: 'x' });
const traffic = (pageviews: number) => Response.json({ data: { viewer: { accounts: [{
  total: [{ count: pageviews, sum: { visits: Math.ceil(pageviews / 2) } }],
  byReferer: [{ count: pageviews, sum: { visits: Math.ceil(pageviews / 2) }, dimensions: { refererHost: 'chatgpt.com' } }],
}] } }, errors: null });

async function store() {
  const { getStore } = await import('../../lib/datastore');
  return getStore();
}

async function customerSite(extra: Partial<Site> = {}) {
  await (await store()).setDoc(paths.site(ORG, SITE), { name: 'Shop', publishing_mode: 'customer_git', created_at: new Date().toISOString(), ...extra });
  await (await store()).setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), { name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false });
  await (await store()).setDoc(`${paths.site(ORG, SITE)}/publishing/domains`, {
    revision: 'r', desired: { website_host: 'www.shop.example', media_host: null, media_path_prefix: '' }, active: null, media_aliases: [], dns_mode: 'automatic', state: 'declared',
  });
}

async function oauthConnection(scope: string, groupId = 'default', accountId = ORG_ACCOUNT) {
  const { connectionPath, sealCredentials } = await import('../../lib/publishing/connections');
  await (await store()).setDoc(connectionPath(ORG, 'cloudflare', groupId), {
    status: 'connected', revision: `rev-${groupId}`, auth_method: 'oauth', connected_at: '2026-10-01T00:00:00.000Z',
    cloudflare: { account_id: accountId, account_name: 'Shop AB', bucket: 'originals', public_bucket: 'public', endpoint: '' },
    encrypted_credentials: sealCredentials(ORG, 'cloudflare', { oauth: { access_token: `oauth-${groupId}`, refresh_token: 'refresh', expires_at: Date.now() + 3_600_000, scope } }, groupId),
  });
}

async function tokenConnection(groupId: string, accountId: string) {
  const { connectionPath, sealCredentials } = await import('../../lib/publishing/connections');
  await (await store()).setDoc(connectionPath(ORG, 'cloudflare', groupId), {
    status: 'connected', revision: `rev-${groupId}`, auth_method: 'api_token', connected_at: '2026-10-01T00:00:00.000Z',
    cloudflare: { account_id: accountId, account_name: 'Group account', bucket: '', endpoint: '' },
    encrypted_credentials: sealCredentials(ORG, 'cloudflare', { api_token: `token-${groupId}` }, groupId),
  });
}

async function save(config: Record<string, unknown>, fetchImpl: typeof fetch, enabled = true) {
  const { saveAppState } = await import('../../lib/apps/manage');
  return saveAppState({ orgId: ORG, siteId: SITE, appId: 'analytics', enabled, config, fetchImpl });
}

async function appsDoc() {
  return (await (await store()).getDoc<SiteApps>(paths.apps(ORG, SITE))) ?? undefined;
}

async function insights(fetchImpl: typeof fetch) {
  const { getInsights } = await import('../../lib/apps/insights');
  const doc = await appsDoc();
  const siteDoc = await (await store()).getDoc<Site>(paths.site(ORG, SITE));
  return getInsights({ orgId: ORG, siteId: SITE, site: siteDoc, appsDoc: doc, days: 30, fetchImpl });
}

const usedPlatform = (calls: Call[]) => calls.some(call => call.url.includes(PLATFORM_ACCOUNT) || call.auth === 'Bearer platform-token' ||
  (call.body?.variables?.accountTag === PLATFORM_ACCOUNT));

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  vi.resetModules();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', PLATFORM_ACCOUNT);
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'platform-token');
  vi.stubEnv('SITES_BASE_DOMAIN', 'sites.platform.example');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('customer publishing: the Organization’s Cloudflare account', () => {
  it('provisions the Web Analytics site in the Default hosting account and never touches the installation account', async () => {
    await customerSite();
    await oauthConnection(ANALYTICS_SCOPES);
    const cf = cloudflare(call => call.method === 'POST' && call.url.endsWith(`/accounts/${ORG_ACCOUNT}/rum/site_info`)
      ? ok(site(ORG_TAG, ORG_TOKEN, call.body.host)) : undefined);

    const result = await save({}, cf.fetchImpl);

    expect(cf.calls).toHaveLength(1);
    expect(cf.calls[0]).toMatchObject({ auth: 'Bearer oauth-default', body: { host: 'www.shop.example', auto_install: false } });
    expect(result.state.config).toMatchObject({ beacon_token: ORG_TOKEN, site_tag: ORG_TAG });
    expect(result.setup).toMatchObject({ status: 'ready', account: { owner: 'organization', account_id: ORG_ACCOUNT, hosting_group_id: 'default' } });
    expect((await appsDoc())?.apps?.analytics?.setup?.status).toBe('ready');
    expect(usedPlatform(cf.calls)).toBe(false);
    const { cloudflareResourceOwner } = await import('../../lib/publishing/cloudflare-account-claims');
    expect(await cloudflareResourceOwner(ORG_ACCOUNT, 'web_analytics_site', ORG_TAG)).toBe(ORG);

    // Re-saving a verified site makes no Cloudflare call.
    await save({}, cf.fetchImpl);
    expect(cf.calls).toHaveLength(1);
  });

  it('uses the account of the site’s own Hosting Group', async () => {
    const { saveHostingGroup } = await import('../../lib/publishing/hosting-groups');
    await oauthConnection(ANALYTICS_SCOPES);
    const group = await saveHostingGroup(ORG, { name: 'Second', sites_domain: 'sites2.shop.example', dns_mode: 'automatic' });
    await tokenConnection(group.id, GROUP_ACCOUNT);
    await customerSite({ hosting_group_id: group.id });
    const cf = cloudflare(call => call.method === 'POST' && call.url.endsWith(`/accounts/${GROUP_ACCOUNT}/rum/site_info`)
      ? ok(site('3'.repeat(32), '4'.repeat(32), call.body.host)) : undefined);

    const result = await save({}, cf.fetchImpl);

    expect(cf.calls.map(call => call.auth)).toEqual([`Bearer token-${group.id}`]);
    expect(result.setup).toMatchObject({ status: 'ready', account: { owner: 'organization', account_id: GROUP_ACCOUNT, hosting_group_id: group.id } });
    expect(usedPlatform(cf.calls)).toBe(false);
  });

  it('returns a structured reason when the OAuth connection lacks the Analytics permission, without calling Cloudflare', async () => {
    await customerSite();
    await oauthConnection(BASE_SCOPES);
    const cf = cloudflare(() => ok({}));

    const result = await save({}, cf.fetchImpl);

    expect(cf.calls).toHaveLength(0);
    expect(result.state.enabled).toBe(true);
    expect(result.state.config.beacon_token).toBeUndefined();
    expect(result.setup).toMatchObject({
      status: 'action_required', code: 'analytics_cloudflare_access_required', settings_url: '/app/settings/publishing',
      account: { owner: 'organization', account_id: ORG_ACCOUNT },
    });
    expect(result.setup?.next_step).toContain('Approve Analytics access');
    const { incompleteSetupError } = await import('../../lib/apps/manage');
    expect(incompleteSetupError('analytics', result.state, result.setup)).toMatchObject({ status: 409, code: 'analytics_cloudflare_access_required' });
  });

  it('points to the one Publishing approval when the deployment requests the Analytics scopes', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', 'account-settings.write account-analytics.read');
    const { saveHostingGroup } = await import('../../lib/publishing/hosting-groups');
    const group = await saveHostingGroup(ORG, { name: 'Moveria hosting', dns_mode: 'automatic' });
    await oauthConnection(BASE_SCOPES, group.id, GROUP_ACCOUNT);
    await customerSite({ hosting_group_id: group.id });
    const cf = cloudflare(() => ok({}));

    const result = await save({}, cf.fetchImpl);

    expect(cf.calls).toHaveLength(0);
    expect(result.setup).toMatchObject({ code: 'analytics_cloudflare_access_required', settings_url: `/app/settings/publishing#hosting-${group.id}` });
    expect(result.setup?.next_step).toContain('“Approve update” on the Hosting Group “Moveria hosting” card');
    expect(result.setup?.next_step).not.toContain('Approve Analytics access');
    expect(await insights(cf.fetchImpl)).toMatchObject({ status: 'no_site_tag' });
  });

  it('provisions on the first update_app after a Connect Cloudflare that granted the onboarding scopes', async () => {
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', 'account-settings.write account-analytics.read dynamic-redirect.read dynamic-redirect.write');
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-client-secret');
    await customerSite();
    const { startCloudflareConnection, finishCloudflareConnection } = await import('../../lib/publishing/cloudflare-oauth');
    const session = { orgId: ORG, userId: 'u1', email: 'admin@example.com' } as never;
    const started = await startCloudflareConnection(session);
    const requested = new URL(started.url).searchParams.get('scope')!;
    const oauth = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/oauth2/token') return Response.json({ access_token: 'oauth-default', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: requested });
      if (path === '/client/v4/accounts') return ok([{ id: ORG_ACCOUNT, name: 'Shop AB' }]);
      if (path === `/client/v4/accounts/${ORG_ACCOUNT}`) return ok({ id: ORG_ACCOUNT, name: 'Shop AB' });
      if (path.endsWith('/pages/projects')) return ok([]);
      throw new Error(`unexpected ${path}`);
    });
    expect(await finishCloudflareConnection(session, { state: new URL(started.url).searchParams.get('state')!, browser: started.browser, code: 'c' }, oauth)).toBe('connected');

    const cf = cloudflare(call => call.method === 'POST' && call.url.endsWith(`/accounts/${ORG_ACCOUNT}/rum/site_info`) ? ok(site(ORG_TAG, ORG_TOKEN, call.body.host)) : undefined);
    const result = await save({}, cf.fetchImpl);
    expect(result.setup).toMatchObject({ status: 'ready' });
    expect(result.state.config).toMatchObject({ beacon_token: ORG_TOKEN, site_tag: ORG_TAG });
  });

  it('refuses to fall back to the installation account when the Hosting Group is not connected', async () => {
    await customerSite();
    const cf = cloudflare(() => ok(site(ORG_TAG, ORG_TOKEN, 'x')));

    const result = await save({}, cf.fetchImpl);

    expect(cf.calls).toHaveLength(0);
    expect(result.setup).toMatchObject({ status: 'action_required', code: 'analytics_cloudflare_connection_required' });
    expect((await insights(cf.fetchImpl))).toMatchObject({ status: 'connection_required', reason: { code: 'analytics_cloudflare_connection_required' } });
  });

  it('surfaces Cloudflare API errors with status and codes but never the provider body', async () => {
    await customerSite();
    await tokenConnection('default', ORG_ACCOUNT);
    let status = 403;
    const cf = cloudflare(() => Response.json({ success: false, errors: [{ code: 10000, message: 'secret-provider-detail' }] }, { status }));

    const denied = await save({}, cf.fetchImpl);
    expect(denied.setup).toMatchObject({ status: 'action_required', code: 'analytics_cloudflare_access_required' });
    expect(denied.setup?.next_step).toContain('Account Settings → Edit');

    status = 502;
    const failed = await save({}, cf.fetchImpl);
    expect(failed.setup).toMatchObject({ status: 'action_required', code: 'analytics_provider_error' });
    expect(failed.setup?.message).toContain('HTTP 502');
    expect(failed.setup?.message).toContain('10000');
    expect(JSON.stringify(failed)).not.toContain('secret-provider-detail');

    status = 429;
    expect((await save({}, cf.fetchImpl)).setup?.code).toBe('analytics_provider_rate_limited');
  });

  it('asks for a site address when none exists', async () => {
    await (await store()).setDoc(paths.site(ORG, SITE), { name: 'Shop', publishing_mode: 'customer_git' });
    await oauthConnection(ANALYTICS_SCOPES);
    const cf = cloudflare(() => undefined);
    expect((await save({}, cf.fetchImpl)).setup?.code).toBe('analytics_host_required');
    expect(cf.calls).toHaveLength(0);
  });
});

describe('manually pasted tokens', () => {
  it('resolves a token from the Organization’s account to its site_tag', async () => {
    await customerSite();
    await oauthConnection(BASE_SCOPES);
    const cf = cloudflare(call => call.url.includes(`/accounts/${ORG_ACCOUNT}/rum/site_info/list`)
      ? ok([site('9'.repeat(32), '8'.repeat(32), 'other.example'), site(ORG_TAG, ORG_TOKEN, 'www.shop.example')], { result_info: { total_pages: 1 } }) : undefined);

    const result = await save({ beacon_token: ORG_TOKEN }, cf.fetchImpl);

    expect(result.state.config).toMatchObject({ beacon_token: ORG_TOKEN, site_tag: ORG_TAG });
    expect(result.setup).toMatchObject({ status: 'ready', account: { account_id: ORG_ACCOUNT } });
    expect(cf.calls.every(call => call.auth === 'Bearer oauth-default')).toBe(true);
  });

  it('rejects a token that is not in the hosting account and saves nothing', async () => {
    await customerSite();
    await oauthConnection(ANALYTICS_SCOPES);
    const cf = cloudflare(call => call.url.includes('/rum/site_info/list') ? ok([], { result_info: { total_pages: 1 } }) : undefined);

    await expect(save({ beacon_token: 'f'.repeat(32) }, cf.fetchImpl)).rejects.toMatchObject({
      status: 409, code: 'analytics_token_not_in_account', details: { account: { account_id: ORG_ACCOUNT } },
    });
    expect(await appsDoc()).toBeUndefined();
  });

  it('rejects a token whose Web Analytics site another Organization owns in a shared account', async () => {
    await customerSite();
    await oauthConnection(BASE_SCOPES);
    const { claimCloudflareResource } = await import('../../lib/publishing/cloudflare-account-claims');
    await claimCloudflareResource('otherorg', ORG_ACCOUNT, 'web_analytics_site', ORG_TAG);
    const cf = cloudflare(call => call.url.includes('/rum/site_info/list') ? ok([site(ORG_TAG, ORG_TOKEN, 'x')], { result_info: { total_pages: 1 } }) : undefined);

    await expect(save({ beacon_token: ORG_TOKEN }, cf.fetchImpl)).rejects.toMatchObject({ code: 'analytics_site_owned_by_other_organization' });
  });
});

describe('Insights reads the account the beacon belongs to', () => {
  it('queries the Organization’s account with its credential', async () => {
    await customerSite();
    await oauthConnection(ANALYTICS_SCOPES);
    const cf = cloudflare(call => call.method === 'POST' && call.url.endsWith('/rum/site_info') ? ok(site(ORG_TAG, ORG_TOKEN, 'www.shop.example'))
      : call.url.endsWith('/graphql') ? traffic(12) : undefined);
    await save({}, cf.fetchImpl);

    const result = await insights(cf.fetchImpl);

    expect(result).toMatchObject({ status: 'ok', total_pageviews: 12, account: { owner: 'organization', account_id: ORG_ACCOUNT } });
    const query = cf.calls.find(call => call.url.endsWith('/graphql'))!;
    expect(query.auth).toBe('Bearer oauth-default');
    expect(query.body.variables).toMatchObject({ accountTag: ORG_ACCOUNT, siteTag: ORG_TAG });
    expect(usedPlatform(cf.calls)).toBe(false);
  });

  it('reports missing read access, authorization errors and outages instead of an empty period', async () => {
    await customerSite();
    await oauthConnection(BASE_SCOPES);
    const pasted = cloudflare(call => call.url.includes('/rum/site_info/list') ? ok([site(ORG_TAG, ORG_TOKEN, 'x')], { result_info: { total_pages: 1 } }) : undefined);
    await save({ beacon_token: ORG_TOKEN }, pasted.fetchImpl);

    const none = cloudflare(() => undefined);
    expect(await insights(none.fetchImpl)).toMatchObject({ status: 'access_required', reason: { code: 'analytics_cloudflare_access_required' } });
    expect(none.calls).toHaveLength(0);

    await oauthConnection(ANALYTICS_SCOPES);
    const denied = cloudflare(() => Response.json({ data: null, errors: [{ message: 'not authorized for that account', extensions: { code: 'authz' } }] }));
    expect((await insights(denied.fetchImpl)).status).toBe('access_required');

    const down = cloudflare(() => new Response('upstream', { status: 503 }));
    const outage = await insights(down.fetchImpl);
    expect(outage).toMatchObject({ status: 'provider_error', reason: { code: 'analytics_provider_error' } });
  });

  it('flags a beacon from another account, such as a site moved from managed hosting', async () => {
    await customerSite();
    await oauthConnection(ANALYTICS_SCOPES);
    // Saved before this change: no recorded account, tag from the installation account.
    await (await store()).setDoc(paths.apps(ORG, SITE), { apps: { analytics: { enabled: true, config: { beacon_token: 'old', site_tag: 'd'.repeat(32) } } } });
    const cf = cloudflare(() => undefined); // the Organization's account does not know the tag

    expect(await insights(cf.fetchImpl)).toMatchObject({ status: 'account_mismatch', reason: { code: 'analytics_account_mismatch' } });
    expect(usedPlatform(cf.calls)).toBe(false);

    // An action-required setup names only the target account; the beacon is still checked there.
    await (await store()).setDoc(paths.apps(ORG, SITE), { apps: { analytics: { enabled: true, config: { beacon_token: 'old', site_tag: 'd'.repeat(32) },
      setup: { status: 'action_required', code: 'analytics_token_not_in_account', account: { owner: 'organization', account_id: ORG_ACCOUNT }, checked_at: '2026-10-01T00:00:00.000Z' } } } });
    const pending = cloudflare(() => undefined);
    expect((await insights(pending.fetchImpl)).status).toBe('account_mismatch');
    expect(pending.calls.some(call => call.url.endsWith('/graphql'))).toBe(false);

    // A recorded installation account is a mismatch without asking Cloudflare.
    await (await store()).setDoc(paths.apps(ORG, SITE), { apps: { analytics: { enabled: true, config: { beacon_token: 'old', site_tag: 'd'.repeat(32) },
      setup: { status: 'ready', account: { owner: 'installation', account_id: PLATFORM_ACCOUNT }, checked_at: '2026-10-01T00:00:00.000Z' } } } });
    const quiet = cloudflare(() => undefined);
    expect((await insights(quiet.fetchImpl)).status).toBe('account_mismatch');
    expect(quiet.calls).toHaveLength(0);
    expect((await save({}, quiet.fetchImpl)).setup?.code).toBe('analytics_account_mismatch');
  });
});

describe('managed and self-hosted sites keep the installation account', () => {
  it('provisions and reads with the installation account', async () => {
    await (await store()).setDoc(paths.site(ORG, SITE), { name: 'Shop', domain: 'shop.example', hosting_config: { pages_project: 'p' } });
    await oauthConnection(ANALYTICS_SCOPES); // an Organization connection must not be used for a managed site
    const cf = cloudflare(call => call.method === 'POST' && call.url.endsWith(`/accounts/${PLATFORM_ACCOUNT}/rum/site_info`) ? ok(site('5'.repeat(32), '6'.repeat(32), call.body.host))
      : call.url.endsWith('/graphql') ? traffic(3) : undefined);

    const result = await save({}, cf.fetchImpl);
    expect(result.state.config).toMatchObject({ beacon_token: '6'.repeat(32), site_tag: '5'.repeat(32) });
    expect(result.setup).toMatchObject({ status: 'ready', account: { owner: 'installation', account_id: PLATFORM_ACCOUNT } });
    expect(cf.calls[0]).toMatchObject({ auth: 'Bearer platform-token', body: { host: 'shop.example' } });

    expect(await insights(cf.fetchImpl)).toMatchObject({ status: 'ok', account: { owner: 'installation' } });
    expect(cf.calls.every(call => call.auth === 'Bearer platform-token')).toBe(true);
  });

  it('keeps accepting a pasted token without an installation account, and says Insights cannot read it', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    await (await store()).setDoc(paths.site(ORG, SITE), { name: 'Shop', domain: 'shop.example' });
    const cf = cloudflare(() => undefined);

    const pasted = await save({ beacon_token: 'tok-xyz' }, cf.fetchImpl);
    expect(pasted.state.config.beacon_token).toBe('tok-xyz');
    expect(pasted.setup).toMatchObject({ status: 'action_required', code: 'analytics_account_not_configured' });
    const { incompleteSetupError } = await import('../../lib/apps/manage');
    expect(incompleteSetupError('analytics', pasted.state, pasted.setup)).toBeNull();
    expect((await insights(cf.fetchImpl)).status).toBe('not_configured');
    expect(cf.calls).toHaveLength(0);
  });
});

describe('HTTP API (read_app / update_app)', () => {
  async function apiKey() {
    const { createApiKey } = await import('../../lib/api-keys');
    return (await createApiKey({ orgId: ORG, siteId: SITE, name: 'site', createdBy: 'admin@example.com' })).token;
  }
  async function call(method: 'GET' | 'PUT', token: string, body?: unknown) {
    const route = await import('../../pages/api/v1/sites/[siteId]/apps/[appId]') as Record<string, APIRoute>;
    const request = new Request(`http://localhost/api/v1/sites/${SITE}/apps/analytics`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return route[method]({ request, params: { siteId: SITE, appId: 'analytics' }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
  }

  it('answers update_app with 409, the cause and the next step when no beacon could be set up, and read_app shows it', async () => {
    await customerSite();
    await oauthConnection(BASE_SCOPES);
    const token = await apiKey();
    vi.stubGlobal('fetch', cloudflare(() => undefined).fetchImpl);

    const response = await call('PUT', token, { enabled: true });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'analytics_cloudflare_access_required', details: { saved: true, app_id: 'analytics', settings_url: '/app/settings/publishing' } });
    expect(body.details.next_step).toContain('Approve Analytics access');
    expect(body.details.state).toMatchObject({ enabled: true, setup: { code: 'analytics_cloudflare_access_required' } });

    const read = await (await call('GET', token)).json();
    expect(read.setup).toMatchObject({ status: 'action_required', code: 'analytics_cloudflare_access_required' });
  });

  it('read_app describes an enabled Analytics app saved without a beacon before setup was recorded', async () => {
    await customerSite();
    await (await store()).setDoc(paths.apps(ORG, SITE), { apps: { analytics: { enabled: true, config: {} } } });
    const read = await (await call('GET', await apiKey())).json();
    expect(read.setup).toMatchObject({ status: 'action_required', code: 'analytics_not_provisioned' });
  });

  it('answers ok with the ready setup after provisioning', async () => {
    await customerSite();
    await oauthConnection(ANALYTICS_SCOPES);
    vi.stubGlobal('fetch', cloudflare(call => call.method === 'POST' ? ok(site(ORG_TAG, ORG_TOKEN, 'www.shop.example')) : undefined).fetchImpl);
    const response = await call('PUT', await apiKey(), { enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, setup: { status: 'ready' }, state: { config: { beacon_token: ORG_TOKEN, site_tag: ORG_TAG } } });
  });
});

describe('Cloudflare consent for Analytics', () => {
  it('requests the Analytics permissions only when asked, and keeps them on reconnect', async () => {
    vi.stubEnv('PORTAL_PUBLIC_URL', 'http://localhost');
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_ID', 'synthetic-client');
    vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_CLIENT_SECRET', 'synthetic-client-secret');
    const { startCloudflareConnection } = await import('../../lib/publishing/cloudflare-oauth');
    const session = { orgId: ORG, userId: 'u1', email: 'admin@example.com' } as never;
    const scopes = async (analytics: boolean) => new URL((await startCloudflareConnection(session, 'default', false, analytics)).url).searchParams.get('scope')!.split(' ');

    expect(await scopes(false)).not.toContain('account-settings.write');
    expect(await scopes(true)).toEqual(expect.arrayContaining(['account-settings.write', 'account-analytics.read']));
    await oauthConnection(ANALYTICS_SCOPES);
    expect(await scopes(false)).toEqual(expect.arrayContaining(['account-settings.write', 'account-analytics.read']));
  });
});
