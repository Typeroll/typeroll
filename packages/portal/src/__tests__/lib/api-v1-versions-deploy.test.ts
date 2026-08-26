// Tests for /v1/versions + /v1/deploy* endpoints.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';

async function setup(): Promise<{ token: string }> {
  makeTmpFixtures();
  await resetDatastore();
  process.env.DEPLOY_QUEUE = 'in_process'; // exercise the local queue
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'My Site', created_at: new Date().toISOString() } satisfies Partial<Site>);
  await getStore().setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
    name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
  } satisfies Partial<SiteVersion>);
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: ORG, siteId: SITE, name: 'test', createdBy: 'admin@example.com' });
  return { token };
}

interface CallInit { headers?: HeadersInit; body?: unknown }
async function callRoute(
  routeImport: Promise<Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', APIRoute>>>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: CallInit,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  const body = init?.body != null && typeof init.body !== 'string' ? JSON.stringify(init.body) : (init?.body as string | undefined);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body,
  });
  return handler({ request: req, params, cookies: { get: () => undefined } as any, locals: {} as any } as any) as Promise<Response>;
}
function bearer(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

describe('versions endpoints', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('GET / always includes main', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/versions/index'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/versions`,
      { siteId: SITE },
      { headers: bearer(token) },
    );
    const body = await res.json() as { versions: Array<{ id: string }> };
    expect(body.versions.map((v) => v.id)).toContain(MAIN_VERSION_ID);
  });

  it('POST / creates a branch with robots_blocked=true', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/versions/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/versions`,
      { siteId: SITE },
      { headers: bearer(token), body: { name: 'Pricing refresh' } },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { version: { id: string; robots_blocked: boolean; kind: string } };
    expect(body.version.id).toBe('pricing-refresh');
    expect(body.version.robots_blocked).toBe(true);
    expect(body.version.kind).toBe('branch');
  });

  it('POST / rejects "main" as a name slug', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/versions/index'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/versions`,
      { siteId: SITE },
      { headers: bearer(token), body: { name: 'main' } },
    );
    expect(res.status).toBe(400);
  });

  it('GET /main returns the main version doc', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/versions/[versionId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/versions/main`,
      { siteId: SITE, versionId: 'main' },
      { headers: bearer(token) },
    );
    const body = await res.json() as { version: { id: string; kind: string } };
    expect(body.version.id).toBe(MAIN_VERSION_ID);
    expect(body.version.kind).toBe('main');
  });

  it('DELETE / refuses to remove main', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/versions/[versionId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/versions/main`,
      { siteId: SITE, versionId: 'main' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(400);
  });

  it('DELETE / removes a branch', async () => {
    const { token } = await setup();
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.version(ORG, SITE, 'feature'), {
      name: 'Feature', kind: 'branch', base_version_id: MAIN_VERSION_ID,
      created_at: new Date().toISOString(), robots_blocked: true,
    } satisfies Partial<SiteVersion>);

    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/versions/[versionId]'),
      'DELETE',
      `http://localhost/api/v1/sites/${SITE}/versions/feature`,
      { siteId: SITE, versionId: 'feature' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(200);
    expect(await getStore().getDoc(paths.version(ORG, SITE, 'feature'))).toBeNull();
  });
});

describe('POST /v1/.../deploy', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('enqueues a job and returns a job_id', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/deploy'),
      'POST',
      `http://localhost/api/v1/sites/${SITE}/deploy`,
      { siteId: SITE },
      { headers: bearer(token), body: {} },
    );
    expect(res.status).toBe(202);
    const body = await res.json() as { job_id: string; version_id: string; environment: string };
    expect(body.job_id).toBeTruthy();
    expect(body.version_id).toBe(MAIN_VERSION_ID);
    expect(body.environment).toBe('production');

    const { getStore } = await import('../../lib/datastore');
    const job = await getStore().getDoc(paths.deploy(ORG, SITE, body.job_id));
    expect(job).not.toBeNull();
  });
});

describe('GET /v1/.../deploys/{jobId}', () => {
  beforeEach(async () => { await resetDatastore(); });

  it('returns 404 for unknown jobs', async () => {
    const { token } = await setup();
    const res = await callRoute(
      import('../../pages/api/v1/sites/[siteId]/deploys/[jobId]'),
      'GET',
      `http://localhost/api/v1/sites/${SITE}/deploys/nope`,
      { siteId: SITE, jobId: 'nope' },
      { headers: bearer(token) },
    );
    expect(res.status).toBe(404);
  });
});
