import { beforeEach, describe, expect, it } from 'vitest';
import type { APIRoute } from 'astro';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<string> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), {
    name: 'My Site',
    created_at: new Date().toISOString(),
  } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main',
    kind: 'main',
    created_at: new Date().toISOString(),
    robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({
    orgId: ORG,
    siteId: SITE,
    name: 'test',
    createdBy: 'admin@example.com',
  })).token;
}

async function post(token: string, body: unknown): Promise<Response> {
  const route = await import('../../pages/api/v1/sites/[siteId]/migration-preflight');
  const handler = route.POST as APIRoute;
  return handler({
    request: new Request(`http://localhost/api/v1/sites/${SITE}/migration-preflight`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: { siteId: SITE },
    cookies: { get: () => undefined },
    locals: {},
  } as never) as Promise<Response>;
}

describe('POST /api/v1/sites/{siteId}/migration-preflight', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns composition dependencies and folds them into readiness', async () => {
    const token = await setup();
    const response = await post(token, {
      compositions: [{
        id: 'article',
        name: 'Article',
        fields: [{ name: 'title' }],
        blocks: [{ id: 'body', type: 'template/item_body', data: { field: 'body' } }],
      }],
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ready: boolean;
      compositions_ready: boolean;
      template_capabilities_version: string;
      composition_reviews: Array<{
        status: string;
        missing_item_fields: string[];
      }>;
    };
    expect(body.compositions_ready).toBe(false);
    expect(body.ready).toBe(false);
    expect(body.template_capabilities_version).toBeTruthy();
    expect(body.composition_reviews[0]).toMatchObject({
      status: 'waiting_for_native_support',
      missing_item_fields: ['body'],
    });
  });

  it('rejects malformed proposals before running the preflight', async () => {
    const token = await setup();
    const response = await post(token, { compositions: [{ name: '', blocks: [] }] });
    expect(response.status).toBe(400);
  });
});
