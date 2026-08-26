// The per-site apps admin route: enable/disable + config, admin-gated,
// masked reads. Analytics is OFF until explicitly enabled here — this is
// the only writer, and it's a cookie-auth admin surface (never AI/MCP).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { SharePermission, SiteApps } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

function mockAccess(permission: SharePermission): void {
  vi.doMock('../../lib/access', async () => {
    const actual = await vi.importActual<typeof import('../../lib/access')>('../../lib/access');
    return {
      ...actual,
      requireSiteAccess: vi.fn(async () => ({
        ok: true as const,
        value: {
          session: { orgId: ORG, userId: 'u1', email: 't@example.com' },
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', status: 'live', created_at: '' },
          versionId: 'main',
          owner_org_id: ORG,
          permission,
        },
      })),
    };
  });
}

async function put(appId: string, body: unknown): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/apps/[appId]');
  return mod.PUT({
    request: new Request(`http://localhost/api/sites/${SITE}/apps/${appId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    cookies: { get: () => undefined },
    params: { siteId: SITE, appId },
    locals: {},
  } as never) as Promise<Response>;
}

async function listApps(): Promise<Response> {
  const mod = await import('../../pages/api/sites/[siteId]/apps/index');
  return mod.GET({
    cookies: { get: () => undefined }, params: { siteId: SITE }, locals: {},
  } as never) as Promise<Response>;
}

describe('apps admin route', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
    delete process.env.CLOUDFLARE_ACCOUNT_ID; // no auto-provision in tests
  });

  it('enables analytics with a token and stores it; list reflects it', async () => {
    mockAccess('admin');
    const res = await put('analytics', { enabled: true, config: { beacon_token: 'tok-xyz' } });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.state.enabled).toBe(true);
    expect(out.affects_build).toBe(true);

    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<SiteApps>(paths.apps(ORG, SITE));
    expect(doc?.apps?.analytics?.enabled).toBe(true);
    expect(doc?.apps?.analytics?.config.beacon_token).toBe('tok-xyz');

    const list = await (await listApps()).json();
    const analytics = list.apps.find((a: { id: string }) => a.id === 'analytics');
    expect(analytics.state.enabled).toBe(true);
    expect(analytics.state.config.beacon_token).toBe('tok-xyz');
  });

  it('disables analytics (config preserved, flag off)', async () => {
    mockAccess('admin');
    await put('analytics', { enabled: true, config: { beacon_token: 'keep' } });
    const res = await put('analytics', { enabled: false, config: {} });
    expect(res.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<SiteApps>(paths.apps(ORG, SITE));
    expect(doc?.apps?.analytics?.enabled).toBe(false);
    expect(doc?.apps?.analytics?.config.beacon_token).toBe('keep');
  });

  it('404s an unknown app', async () => {
    mockAccess('admin');
    expect((await put('nope', { enabled: true })).status).toBe(404);
  });

  it('non-admins are rejected (write shares can edit content, not enable apps)', async () => {
    mockAccess('write');
    expect((await put('analytics', { enabled: true })).status).toBe(403);
  });
});
