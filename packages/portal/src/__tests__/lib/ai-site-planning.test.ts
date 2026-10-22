// "Plan a new site with AI" (portal form) refuses up front with
// ai_not_enabled when the Organization's own AI key would not cover the new
// Site — no key, or Site access limited to selected existing Sites — and
// creates nothing. With a key for all Sites it creates the Site and starts
// planning. The public-API route is covered in api-v1-workflows.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import type { Site } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const started = vi.hoisted(() => [] as string[]);
vi.mock('../../lib/workflows/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/workflows/engine')>();
  return { WorkflowEngine: class extends actual.WorkflowEngine {
    override async start(_orgId: string, workflowId: string) { started.push(workflowId); return {} as never; }
  } };
});
vi.mock('../../lib/hosting/site-provisioning', () => ({ provisionSiteHosting: vi.fn(async () => null) }));

const ORG = 'default';
const EXISTING = 'existing';
const FAKE_KEY = 'sk-ant-api03-FAKE-planning-test-key-0000PLAN';

async function store() { return (await import('../../lib/datastore')).getStore(); }

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  started.length = 0;
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  await (await store()).setDoc(paths.site(ORG, EXISTING), { name: 'Existing', created_at: '2026-01-01' });
});

async function enable(mode: 'all' | 'selected') {
  const { setAiKey, setAiSiteAccess } = await import('../../lib/ai/organization-ai');
  await setAiKey(ORG, { userId: 'owner' }, FAKE_KEY, (async () => new Response('{}', { status: 200 })) as never);
  await setAiSiteAccess(ORG, { userId: 'owner' }, mode === 'all' ? { mode } : { mode, site_ids: [EXISTING] });
}

async function plan() {
  const { POST } = await import('../../pages/api/sites/create-and-plan');
  const response = await POST({
    request: new Request('https://portal.test/api/sites/create-and-plan', {
      method: 'POST', body: new URLSearchParams({ name: 'Harbor Bakery', business_description: 'A bakery by the harbor.' }),
    }),
    cookies: { get: () => undefined },
    redirect: (url: string) => new Response(null, { status: 302, headers: { location: url } }),
  } as never) as Response;
  return { status: response.status, location: response.headers.get('location'), json: await response.json().catch(() => ({})) as any };
}

async function siteIds() {
  return (await (await store()).listDocs<Site>(paths.sites(ORG))).map((site) => site.id).sort();
}

describe('planning a new site with AI', () => {
  it.each([['no key', null], ['a key for selected Sites only', 'selected']] as const)('refuses with %s and creates nothing', async (_label, mode) => {
    if (mode) await enable(mode);
    const res = await plan();
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: 'ai_not_enabled', settings_url: '/app/settings/ai-assistant' });
    expect(res.json.error).toContain('Organization settings → AI assistant');
    expect(res.json.error).toContain('Nothing was created');
    expect(await siteIds()).toEqual([EXISTING]);
    expect(await (await store()).listDocs(paths.workflows(ORG))).toEqual([]);
    expect(started).toEqual([]);
  });

  it('creates the site and starts planning when the key covers all Sites', async () => {
    await enable('all');
    const res = await plan();
    expect(res.status).toBe(302);
    expect(res.location).toMatch(/^\/app\/sites\/harbor-bakery\/workflows\//);
    expect(await siteIds()).toEqual([EXISTING, 'harbor-bakery']);
    expect(started).toHaveLength(1);
    const { isAiEnabledForSite } = await import('../../lib/ai/organization-ai');
    expect(await isAiEnabledForSite({ orgId: ORG, siteId: 'harbor-bakery' })).toBe(true);
  });

  it('reports whether new Sites are covered', async () => {
    const { readAiSettings, settingsCoverNewSites } = await import('../../lib/ai/organization-ai');
    expect(settingsCoverNewSites(await readAiSettings(ORG))).toBe(false);
    await enable('selected');
    expect(settingsCoverNewSites(await readAiSettings(ORG))).toBe(false);
    await enable('all');
    expect(settingsCoverNewSites(await readAiSettings(ORG))).toBe(true);
  });
});
