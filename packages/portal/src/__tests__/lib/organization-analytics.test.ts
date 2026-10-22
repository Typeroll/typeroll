// One Cloudflare approval per account, then Analytics chosen per Site: the
// Organization overview, its bulk enable/disable (portal, API) and the rule
// that a permission grant enables measurement nowhere. Cloudflare is a
// synthetic double; nothing leaves the process.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { paths, type SiteApps } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'moveria';
const ACCOUNT = 'a'.repeat(32);
const ALL = 'account-settings.read page.read page.write workers-r2.read workers-r2.write offline_access account-settings.write account-analytics.read dynamic-redirect.read dynamic-redirect.write';
const SITES = ['alpha', 'bravo', 'charlie'];

async function store() { return (await import('../../lib/datastore')).getStore(); }

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.resetModules();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://portal.test');
  vi.stubEnv('TYPEROLL_PUBLISH_CLOUDFLARE_OPTIONAL_SCOPES', 'account-settings.write account-analytics.read dynamic-redirect.read dynamic-redirect.write');
  const { connectionPath, sealCredentials } = await import('../../lib/publishing/connections');
  // The connection after one approval: it has every Analytics permission.
  await (await store()).setDoc(connectionPath(ORG, 'cloudflare'), {
    status: 'connected', revision: 'rev', auth_method: 'oauth', cloudflare: { account_id: ACCOUNT, account_name: 'Moveria AB', bucket: 'o', public_bucket: 'p', endpoint: '' },
    encrypted_credentials: sealCredentials(ORG, 'cloudflare', { oauth: { access_token: 'oauth-default', refresh_token: 'r', expires_at: Date.now() + 3_600_000, scope: ALL } }),
  });
  for (const id of SITES) {
    await (await store()).setDoc(paths.site(ORG, id), { name: id[0].toUpperCase() + id.slice(1), publishing_mode: 'customer_git', created_at: '2026-10-01' });
    await (await store()).setDoc(`${paths.site(ORG, id)}/publishing/domains`, {
      revision: 'r', desired: { website_host: `${id}.moveria.se`, media_host: null, media_path_prefix: '' }, active: null, media_aliases: [], dns_mode: 'automatic', state: 'declared' });
  }
  await (await store()).setDoc(paths.site(ORG, 'retired'), { name: 'Retired', publishing_mode: 'customer_git', lifecycle: { status: 'archived', archived_at: '2026-10-01', archived_by: 'u' } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Cloudflare Web Analytics double: creates one site per host and records the hosts. */
function webAnalytics() {
  const hosts: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith(`/accounts/${ACCOUNT}/rum/site_info`)) {
      const host = JSON.parse(String(init.body)).host as string;
      hosts.push(host);
      const tag = host.split('.')[0].padEnd(32, '0');
      return Response.json({ success: true, errors: [], result: { site_tag: tag, site_token: `token-${host.split('.')[0]}`, rules: [{ host }], snippet: '' } });
    }
    return Response.json({ success: false, errors: [{ code: 7003 }] }, { status: 404 });
  });
  return { hosts, fetchImpl };
}

async function apps(siteId: string) {
  return (await (await store()).getDoc<SiteApps>(paths.apps(ORG, siteId))) ?? undefined;
}

describe('Analytics chosen per Site after one approval', () => {
  it('lists every active Site off after the approval: a permission grant enables measurement nowhere', async () => {
    const { readAnalyticsOverview } = await import('../../lib/apps/analytics-overview');
    const overview = await readAnalyticsOverview(ORG);
    expect(overview.sites.map(site => [site.site_id, site.enabled, site.beacon_configured, site.setup])).toEqual([
      ['alpha', false, false, null], ['bravo', false, false, null], ['charlie', false, false, null]]);
    expect(overview.sites[0]).toMatchObject({ hosting_group_id: 'default', hosting_group_name: 'Default' });
    expect(overview.cloudflare_permissions[0].capabilities.every(item => item.status === 'available')).toBe(true);
    for (const id of SITES) expect(await apps(id)).toBeUndefined();
  });

  it('enables only the chosen Sites, each through update_app’s provisioning, and only they publish a beacon', async () => {
    const { setOrganizationAnalytics, readAnalyticsOverview } = await import('../../lib/apps/analytics-overview');
    const { publicAppsSnapshot } = await import('../../lib/apps/config');
    const cf = webAnalytics();

    const results = await setOrganizationAnalytics(ORG, [{ site_id: 'alpha', enabled: true }, { site_id: 'charlie', enabled: true }, { site_id: 'missing', enabled: true }, { site_id: 'retired', enabled: true }], cf.fetchImpl);

    expect(results.map(item => [item.site_id, item.status])).toEqual([['alpha', 'ready'], ['charlie', 'ready'], ['missing', 'error'], ['retired', 'error']]);
    expect(cf.hosts).toEqual(['alpha.moveria.se', 'charlie.moveria.se']);
    expect((await apps('alpha'))?.apps?.analytics?.config).toMatchObject({ beacon_token: 'token-alpha', site_tag: 'alpha'.padEnd(32, '0') });
    expect(await apps('bravo')).toBeUndefined();
    expect(publicAppsSnapshot(await apps('alpha')).apps?.analytics).toEqual({ enabled: true, config: { beacon_token: 'token-alpha' } });
    expect(publicAppsSnapshot(await apps('bravo')).apps?.analytics).toBeUndefined();
    expect((await readAnalyticsOverview(ORG)).sites.map(site => [site.site_id, site.enabled, site.setup?.status ?? null]))
      .toEqual([['alpha', true, 'ready'], ['bravo', false, null], ['charlie', true, 'ready']]);

    const off = await setOrganizationAnalytics(ORG, [{ site_id: 'charlie', enabled: false }], cf.fetchImpl);
    expect(off).toEqual([{ site_id: 'charlie', enabled: false, status: 'disabled' }]);
    expect(publicAppsSnapshot(await apps('charlie')).apps?.analytics).toBeUndefined();
    expect(cf.hosts).toHaveLength(2);
  });

  it('reports per Site what still needs an action, without stopping the others', async () => {
    const { connectionPath, sealCredentials } = await import('../../lib/publishing/connections');
    await (await store()).updateDoc(connectionPath(ORG, 'cloudflare'), {
      encrypted_credentials: sealCredentials(ORG, 'cloudflare', { oauth: { access_token: 'oauth-default', refresh_token: 'r', expires_at: Date.now() + 3_600_000, scope: 'account-settings.read page.read page.write workers-r2.read workers-r2.write offline_access' } }),
    });
    const { setOrganizationAnalytics } = await import('../../lib/apps/analytics-overview');
    const cf = webAnalytics();
    const results = await setOrganizationAnalytics(ORG, [{ site_id: 'alpha', enabled: true }, { site_id: 'bravo', enabled: true }], cf.fetchImpl);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({ enabled: true, status: 'action_required', code: 'analytics_cloudflare_access_required', settings_url: '/app/settings/publishing#cloudflare' });
      expect(result.next_step).toContain('Approve update');
    }
    expect(cf.hosts).toEqual([]);
  });

  it('serves the overview and bulk changes to organization API keys only', async () => {
    const { createApiKey } = await import('../../lib/api-keys');
    const orgKey = (await createApiKey({ orgId: ORG, siteId: null, name: 'agent', createdBy: 'owner@example.test' })).token;
    const siteKey = (await createApiKey({ orgId: ORG, siteId: 'alpha', name: 'site', createdBy: 'owner@example.test' })).token;
    const cf = webAnalytics();
    vi.stubGlobal('fetch', cf.fetchImpl);
    const route = await import('../../pages/api/v1/organization/analytics') as Record<string, APIRoute>;
    const call = async (method: string, token: string, body?: unknown) => {
      const response = await route[method]!({ request: new Request('https://portal.test/api/v1/organization/analytics', {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) } as never) as Response;
      return { status: response.status, json: await response.json() as any };
    };

    expect((await call('GET', siteKey)).status).toBe(403);
    const listed = await call('GET', orgKey);
    expect(listed.status).toBe(200);
    expect(listed.json.sites).toHaveLength(3);
    expect(listed.json.cloudflare_permissions[0].hosting_group_id).toBe('default');

    expect((await call('POST', orgKey, { sites: [{ site_id: 'bravo' }] })).status).toBe(400);
    const changed = await call('POST', orgKey, { sites: [{ site_id: 'bravo', enabled: true }] });
    expect(changed.status).toBe(200);
    expect(changed.json.results).toEqual([expect.objectContaining({ site_id: 'bravo', enabled: true, status: 'ready' })]);
    expect(cf.hosts).toEqual(['bravo.moveria.se']);
    expect(JSON.stringify(changed.json)).not.toContain('token-bravo');
    expect(JSON.stringify((await call('GET', orgKey)).json)).not.toContain('token-bravo');
  });
});
