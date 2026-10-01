// Public-API workflows (/api/v1/sites/{siteId}/workflows[/{id}[/approve]])
// and site creation with a first workflow (/api/v1/sites/create-and-migrate,
// /api/v1/sites/create-and-plan). Runs are recorded for real; executing the
// steps is stubbed, since that is the engine's own concern.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { Site, SiteShare } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const started = vi.hoisted(() => ({ start: [] as string[], resume: [] as string[] }));
vi.mock('../../lib/workflows/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/workflows/engine')>();
  return {
    WorkflowEngine: class extends actual.WorkflowEngine {
      override async start(_orgId: string, workflowId: string) { started.start.push(workflowId); return {} as never; }
      override async resume(_orgId: string, workflowId: string) { started.resume.push(workflowId); return {} as never; }
    },
  };
});
vi.mock('../../lib/hosting/site-provisioning', () => ({ provisionSiteHosting: vi.fn(async () => null) }));

const ORG = 'owner-org';
const PARTNER = 'partner-org';
const SITE = 'main-site';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  started.start.length = 0;
  started.resume.length = 0;
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(ORG, SITE), { name: 'Main', created_at: '2026-01-01' });
});
afterEach(() => { vi.unstubAllEnvs(); });

async function key(orgId: string, siteId: string | null): Promise<string> {
  const { createApiKey } = await import('../../lib/api-keys');
  return (await createApiKey({ orgId, siteId, name: 'seed', createdBy: 'person@example.test' })).token;
}

async function sharedKey(permission: SiteShare['permission']): Promise<string> {
  const { writeShare } = await import('../../lib/shares');
  await writeShare({ id: `share-${permission}`, site_id: SITE, owner_org_id: ORG, shared_with_org_id: PARTNER, permission, created_at: Date.now(), created_by: 'person' });
  return key(PARTNER, null);
}

const routes = {
  list: () => import('../../pages/api/v1/sites/[siteId]/workflows/index'),
  one: () => import('../../pages/api/v1/sites/[siteId]/workflows/[workflowId]/index'),
  approve: () => import('../../pages/api/v1/sites/[siteId]/workflows/[workflowId]/approve'),
  migrate: () => import('../../pages/api/v1/sites/create-and-migrate'),
  plan: () => import('../../pages/api/v1/sites/create-and-plan'),
};

async function call(route: keyof typeof routes, method: string, token: string | null, params: Record<string, string>, body?: unknown) {
  const mod = (await routes[route]()) as Record<string, APIRoute>;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const url = new URL('https://portal.test/api/v1/x');
  const res = await mod[method]!({
    request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    params, url,
  } as never) as Response;
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}

describe('site workflows through the public API', () => {
  it('starts, reads, lists and approves a workflow with the same projection as the portal', async () => {
    const token = await key(ORG, SITE);
    const res = await call('list', 'POST', token, { siteId: SITE }, { type: 'seo_audit', config: { note: 'x' } });
    expect(res.status).toBe(202);
    const id = res.json.workflow_id as string;
    expect(started.start).toEqual([id]);

    const read = await call('one', 'GET', token, { siteId: SITE, workflowId: id });
    expect(read.status).toBe(200);
    expect(read.json.workflow).toMatchObject({ id, site_id: SITE, type: 'seo_audit', config: { note: 'x', version: 'main' } });
    expect(read.json.workflow.created_by).toMatch(/^api-key:/);
    expect(read.json.workflow).not.toHaveProperty('state');

    const listed = await call('list', 'GET', token, { siteId: SITE });
    expect(listed.json.workflows.map((w: { id: string }) => w.id)).toEqual([id]);
    expect(listed.json.types.find((t: { type: string }) => t.type === 'rebuild_deploy')).toMatchObject({ required_permission: 'admin' });

    expect((await call('approve', 'POST', token, { siteId: SITE, workflowId: id })).status).toBe(409);
    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(`${paths.workflows(ORG)}/${id}`, { status: 'paused_for_review', review_message: 'Check the plan' });
    const approved = await call('approve', 'POST', token, { siteId: SITE, workflowId: id });
    expect(approved.status).toBe(202);
    expect(started.resume).toEqual([id]);
  });

  it('masks credential config and hides runs of other sites', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(`${paths.workflows(ORG)}/wf_1_secret`, {
      site_id: SITE, type: 'migration', status: 'completed', config: { wp_url: 'https://wp.test', helper_api_key: 'synthetic-helper-key' },
      state: { helper_api_key: 'synthetic-helper-key' }, triggered_by: 'manual', created_by: 'person',
    });
    await getStore().setDoc(`${paths.workflows(ORG)}/wf_2_other`, { site_id: 'other-site', type: 'seo_audit', status: 'completed', config: {}, triggered_by: 'manual', created_by: 'person' });
    const token = await key(ORG, SITE);
    const read = await call('one', 'GET', token, { siteId: SITE, workflowId: 'wf_1_secret' });
    expect(JSON.stringify(read.json)).not.toContain('synthetic-helper-key');
    expect(read.json.workflow.config.helper_api_key).toBe('********');
    expect((await call('one', 'GET', token, { siteId: SITE, workflowId: 'wf_2_other' })).status).toBe(404);
    expect((await call('one', 'GET', token, { siteId: SITE, workflowId: '../x' })).status).toBe(404);
  });

  it('applies the portal permission rules to shared-in sites', async () => {
    const readKey = await sharedKey('read');
    expect((await call('list', 'GET', readKey, { siteId: SITE })).status).toBe(200);
    expect((await call('list', 'POST', readKey, { siteId: SITE }, { type: 'seo_audit' })).status).toBe(403);

    const { getStore } = await import('../../lib/datastore');
    await getStore().updateDoc(paths.share(ORG, SITE, 'share-read'), { permission: 'write' });
    await getStore().updateDoc(paths.sharesWithOrgEntry(PARTNER, 'share-read'), { permission: 'write' });
    expect((await call('list', 'POST', readKey, { siteId: SITE }, { type: 'seo_audit' })).status).toBe(202);
    // Rebuild & deploy publishes, and publishing needs admin like the deploy routes.
    const deploy = await call('list', 'POST', readKey, { siteId: SITE }, { type: 'rebuild_deploy' });
    expect(deploy.status).toBe(403);
    expect(started.start).toHaveLength(1);
  });

  it('validates the workflow type and requires import storage for migration', async () => {
    const token = await key(ORG, SITE);
    const unknown = await call('list', 'POST', token, { siteId: SITE }, { type: 'mine_bitcoin' });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toContain('seo_audit');
    const migration = await call('list', 'POST', token, { siteId: SITE }, { type: 'migration', config: { wp_url: 'https://wp.test' } });
    expect(migration.status).toBe(409);
    expect(migration.json.code).toBe('import_storage_required');
    expect(started.start).toEqual([]);
  });
});

describe('creating a site with its first workflow', () => {
  it('creates and plans a site with an organization key', async () => {
    const token = await key(ORG, null);
    const res = await call('plan', 'POST', token, {}, { name: 'Harbor Bakery', business_description: 'A bakery by the harbor.' });
    expect(res.status).toBe(201);
    expect(res.json.site).toMatchObject({ id: 'harbor-bakery', organization_id: ORG, name: 'Harbor Bakery' });
    expect(res.json.workflow).toMatchObject({ type: 'site_planning', status: 'running' });
    expect(started.start).toEqual([res.json.workflow.id]);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc(paths.settings(ORG, 'harbor-bakery'))).toMatchObject({ site_name: 'Harbor Bakery' });
    const wf = await getStore().getDoc<{ config: unknown; site_id: string }>(`${paths.workflows(ORG)}/${res.json.workflow.id}`);
    expect(wf).toMatchObject({ site_id: 'harbor-bakery', config: { business_description: 'A bakery by the harbor.' } });
  });

  it('refuses site-scoped keys and incomplete input before creating anything', async () => {
    expect((await call('plan', 'POST', await key(ORG, SITE), {}, { name: 'Nope', business_description: 'x' })).status).toBe(403);
    const orgKey = await key(ORG, null);
    expect((await call('plan', 'POST', orgKey, {}, { name: 'Nope' })).status).toBe(400);
    expect((await call('migrate', 'POST', orgKey, {}, { name: 'Nope', wp_url: 'not a url' })).status).toBe(400);
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc<Site>(paths.site(ORG, 'nope'))).toBeNull();
  });

  it('requires verified import storage before creating a site to migrate into', async () => {
    const res = await call('migrate', 'POST', await key(ORG, null), {}, { name: 'Old Blog', wp_url: 'https://wp.test' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('import_storage_required');
    const { getStore } = await import('../../lib/datastore');
    expect(await getStore().getDoc<Site>(paths.site(ORG, 'old-blog'))).toBeNull();
  });

  it('keeps a site whose id equals the static segment reachable', async () => {
    const { getStore } = await import('../../lib/datastore');
    await getStore().setDoc(paths.site(ORG, 'create-and-plan'), { name: 'Unlucky name', created_at: '2026-01-01' });
    const res = await call('plan', 'GET', await key(ORG, null), {});
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).toContain('Unlucky name');
  });
});
