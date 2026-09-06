import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { DeployJob, Site, SiteVersion } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(withDeploy = true): Promise<string> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.site(ORG, SITE), {
    name: 'My Site',
    hosting_adapter: 'cloudflare',
    hosting_config: { fallback_subdomain: 'mysite.sites.example.test' },
    created_at: '2026-09-06T08:00:00.000Z',
  } satisfies Partial<Site>);
  await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: '2026-09-06T08:00:00.000Z', robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  if (withDeploy) {
    await store.setDoc(paths.deploy(ORG, SITE, 'deploy-one'), {
      version_id: MAIN_VERSION_ID,
      environment: 'production',
      status: 'succeeded',
      started_at: '2026-09-06T09:55:00.000Z',
      finished_at: '2026-09-06T10:00:00.000Z',
    } satisfies Omit<DeployJob, 'id'>);
  }
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' })).token;
}

async function putAcceptance(token: string, checkedAt = '2026-09-06T10:30:00+00:00'): Promise<Response> {
  const route = await import('../../pages/api/v1/sites/[siteId]/migration-report/seo-acceptance');
  return (route.PUT as APIRoute)({
    request: new Request(`http://localhost/api/v1/sites/${SITE}/migration-report/seo-acceptance`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'accepted', checked_at: checkedAt, dataset: 'Sitemap and source crawl',
        source_origin: 'https://old.example.test', target_origin: 'https://mysite.sites.example.test',
        checked_pages: 12, differences: { total: 3, intentional: 3, unresolved: 0 },
      }),
    }),
    params: { siteId: SITE }, cookies: { get: () => undefined }, locals: {},
  } as never) as Promise<Response>;
}

describe('migration launch report API', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('binds normalized SEO evidence to the latest successful deploy', async () => {
    const token = await setup();
    const response = await putAcceptance(token);
    expect(response.status).toBe(200);
    const body = await response.json() as { evidence: Record<string, unknown> };
    expect(body.evidence).toMatchObject({
      checked_at: '2026-09-06T10:30:00.000Z',
      deployment_job_id: 'deploy-one',
      deployment_finished_at: '2026-09-06T10:00:00.000Z',
    });
  });

  it('refuses deploy-unbound SEO acceptance', async () => {
    const token = await setup(false);
    const response = await putAcceptance(token);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('successful hosted deploy') });
  });

  it('refuses evidence checked before the deployment finished', async () => {
    const token = await setup();
    const response = await putAcceptance(token, '2026-09-06T09:59:59Z');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('latest successful hosted deploy') });
  });
});
