import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'default';
const SITE = 'mysite';

function mockApiAuth(
  permission: 'read' | 'write' | 'admin' = 'admin',
  path = `/api/v1/sites/${SITE}/apps/funnel_attribution`,
): void {
  vi.doMock('../../lib/api-auth', async () => {
    const actual = await vi.importActual<typeof import('../../lib/api-auth')>('../../lib/api-auth');
    return {
      ...actual,
      requireApiKey: vi.fn(async (request: Request) => ({
        ok: true as const,
        value: {
          orgId: ORG,
          tokenOrgId: ORG,
          tokenSiteId: SITE,
          siteId: SITE,
          site: { id: SITE, name: 'My Site', hosting_adapter: 'cloudflare', created_at: '' },
          versionId: 'main',
          keyPrefix: 'test',
          permission,
          request,
          path,
        },
      })),
    };
  });
}

async function put(body: unknown): Promise<Response> {
  const { PUT } = await import('../../pages/api/v1/sites/[siteId]/apps/[appId]');
  return PUT({
    request: new Request(`http://localhost/api/v1/sites/${SITE}/apps/funnel_attribution`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    params: { siteId: SITE, appId: 'funnel_attribution' },
  } as never) as Promise<Response>;
}

async function putApp(appId: string, body: unknown): Promise<Response> {
  const { PUT } = await import('../../pages/api/v1/sites/[siteId]/apps/[appId]');
  return PUT({
    request: new Request(`http://localhost/api/v1/sites/${SITE}/apps/${appId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    params: { siteId: SITE, appId },
  } as never) as Promise<Response>;
}

async function getApp(appId: string): Promise<Response> {
  const { GET } = await import('../../pages/api/v1/sites/[siteId]/apps/[appId]');
  return GET({
    request: new Request(`http://localhost/api/v1/sites/${SITE}/apps/${appId}`),
    params: { siteId: SITE, appId },
  } as never) as Promise<Response>;
}

describe('funnel attribution bearer API', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
  });

  it('stores validated rules for an admin key', async () => {
    mockApiAuth();
    const response = await put({
      enabled: true,
      config: {
        allow_personal_data: false,
        funnels: [{
          id: 'campaign',
          parameters: [{ from: 'utm_source' }],
          targets: [{ type: 'link', host: 'example.com', path: '/book' }],
        }],
      },
    });
    expect(response.status).toBe(200);
    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<SiteApps>(paths.apps(ORG, SITE));
    expect(doc?.apps?.funnel_attribution?.enabled).toBe(true);
    expect(doc?.apps?.funnel_attribution?.config.funnels).toEqual([
      expect.objectContaining({ id: 'campaign' }),
    ]);
  });

  it('rejects unsafe config and non-admin keys', async () => {
    mockApiAuth();
    expect((await put({
      enabled: true,
      config: {
        funnels: [{
          id: 'bad', parameters: [{ from: 'email' }],
          targets: [{ type: 'link', host: 'example.com', path: '/book' }],
        }],
      },
    })).status).toBe(400);

    vi.resetModules();
    mockApiAuth('write');
    expect((await put({ enabled: false, config: {} })).status).toBe(403);
  });

  it('requires explicit acknowledgement for synthetic fallback attribution', async () => {
    mockApiAuth();
    const base = {
      enabled: true,
      config: {
        funnels: [{
          id: 'campaign', parameters: [{ from: 'utm_source', fallback: 'website' }],
          targets: [{ type: 'link', host: 'example.com', path: '/book' }],
        }],
      },
    };
    expect((await put(base)).status).toBe(400);
    expect((await put({
      ...base,
      config: { ...base.config, allow_synthetic_fallbacks: true },
    })).status).toBe(200);
  });
});

describe('generic apps bearer API', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    vi.resetModules();
  });

  it('lists every registered app with schema and masked state', async () => {
    mockApiAuth('admin', `/api/v1/sites/${SITE}/apps`);
    const { GET } = await import('../../pages/api/v1/sites/[siteId]/apps/index');
    const response = await GET({
      request: new Request(`http://localhost/api/v1/sites/${SITE}/apps`),
      params: { siteId: SITE },
    } as never) as Response;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.apps.map((app: { id: string }) => app.id)).toEqual(
      expect.arrayContaining(['analytics', 'integrations', 'directory', 'funnel_attribution']),
    );
    expect(body.apps.find((app: { id: string }) => app.id === 'analytics')).toMatchObject({
      affects_build: true,
      state: { enabled: false },
    });
  });

  it('enables Analytics with server-side provisioning and preserves other apps', async () => {
    vi.doMock('../../lib/apps/provision-analytics', () => ({
      maybeProvisionWebAnalytics: vi.fn(async () => ({
        beacon_token: 'provisioned-beacon',
        site_tag: 'provisioned-tag',
      })),
    }));
    mockApiAuth('admin', `/api/v1/sites/${SITE}/apps/analytics`);
    const analyticsResponse = await putApp('analytics', { enabled: true, config: {} });
    expect(analyticsResponse.status).toBe(200);
    expect(await analyticsResponse.json()).toMatchObject({
      app_id: 'analytics',
      state: {
        enabled: true,
        config: { beacon_token: 'provisioned-beacon', site_tag: 'provisioned-tag' },
      },
    });

    vi.resetModules();
    mockApiAuth('admin', `/api/v1/sites/${SITE}/apps/integrations`);
    expect((await putApp('integrations', {
      enabled: true,
      config: { google_analytics__measurement_id: 'G-TEST123' },
    })).status).toBe(200);

    const { getStore } = await import('../../lib/datastore');
    const doc = await getStore().getDoc<SiteApps>(paths.apps(ORG, SITE));
    expect(doc?.apps?.analytics?.enabled).toBe(true);
    expect(doc?.apps?.analytics?.config.site_tag).toBe('provisioned-tag');
    expect(doc?.apps?.integrations?.enabled).toBe(true);
  });

  it('reads any registered app and rejects unknown apps or non-admin keys', async () => {
    mockApiAuth();
    const analytics = await getApp('analytics');
    expect(analytics.status).toBe(200);
    expect(await analytics.json()).toMatchObject({ app: { id: 'analytics' } });

    expect((await getApp('not-an-app')).status).toBe(404);

    vi.resetModules();
    mockApiAuth('write', `/api/v1/sites/${SITE}/apps/analytics`);
    expect((await putApp('analytics', { enabled: true, config: {} })).status).toBe(403);
  });

  it('audits config field names without storing submitted values', async () => {
    mockApiAuth('admin', `/api/v1/sites/${SITE}/apps/analytics`);
    const marker = 'must-not-appear-in-audit';
    expect((await putApp('analytics', {
      enabled: true,
      config: { beacon_token: marker },
    })).status).toBe(200);

    await vi.waitFor(async () => {
      const { getStore } = await import('../../lib/datastore');
      const entries = await getStore().listDocs<{ body_preview?: string }>(paths.apiAudit(ORG, SITE));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]?.body_preview).toContain('beacon_token');
      expect(entries[0]?.body_preview).not.toContain(marker);
    });
  });
});
