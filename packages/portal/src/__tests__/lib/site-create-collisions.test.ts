import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createSite } from '../../lib/site-create';
const provision = vi.hoisted(() => vi.fn());
vi.mock('../../lib/hosting/site-provisioning', () => ({ provisionSiteHosting: provision }));
vi.mock('../../lib/site-domain', () => ({ declareDomainAtCreation: vi.fn() }));
vi.mock('../../lib/access', () => ({ requireFullSession: async () => ({ ok: true, value: { orgId: 'test-org', userId: 'test-user' } }) }));
vi.mock('../../lib/workflows/engine', () => ({ WorkflowEngine: class {
  async create() { return 'test-workflow'; }
  async start() {}
} }));
vi.mock('../../lib/workflows/migration', () => ({ migrationWorkflow: {} }));
vi.mock('../../lib/workflows/site-planning', () => ({ sitePlanningWorkflow: {} }));
const org = 'test-org';
const original = {
  name: 'Acme', media_id: 'original-media', domain: 'acme.example', created_at: '2025-01-01',
};
const seedPaths = [paths.settings(org, 'acme'), `${paths.pages(org, 'acme')}/home`, paths.partial(org, 'acme', 'header'), paths.partial(org, 'acme', 'footer')];
beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  await getStore().setDoc(paths.site(org, 'acme'), original);
  for (const path of seedPaths) await getStore().setDoc(path, { original_content: path });
  provision.mockReset().mockImplementation(async (orgId, siteId) => {
    expect(await getStore().getDoc(paths.site(orgId, siteId))).not.toBeNull();
    return null;
  });
});
async function expectOriginalPreserved() {
  expect(await getStore().getDoc(paths.site(org, 'acme'))).toEqual({ id: 'acme', ...original });
  for (const path of seedPaths) expect(await getStore().getDoc(path)).toMatchObject({ original_content: path });
  expect(provision.mock.calls.every((call) => call[1] !== 'acme')).toBe(true);
}

it('reserves distinct sites for simultaneous same-name requests before provisioning', async () => {
  const sites = await Promise.all(Array.from({ length: 6 }, () => createSite({ orgId: org, name: 'New Site' })));
  expect(new Set(sites.map((result) => result.siteId)).size).toBe(6);
  expect(sites.filter((result) => result.siteId === 'new-site')).toHaveLength(1);
  for (const result of sites) expect(await getStore().getDoc(`${paths.pages(org, result.siteId)}/home`)).toMatchObject({ status: 'draft' });
});

it('preserves site metadata, settings and content when creating a colliding site', async () => {
  const result = await createSite({ orgId: org, name: 'Acme' });
  expect(result.siteId).not.toBe('acme');
  await expectOriginalPreserved();
});

it.each(['create', 'create-and-plan', 'create-and-migrate'])('protects existing data through the %s route', async (route) => {
  const { POST } = await ({ create: () => import('../../pages/api/sites/create'), 'create-and-plan': () => import('../../pages/api/sites/create-and-plan'), 'create-and-migrate': () => import('../../pages/api/sites/create-and-migrate') }[route]!)();
  const response = await POST({
    request: new Request(`https://portal.test/api/sites/${route}`, {
      method: 'POST', body: new URLSearchParams({ name: 'Acme', business_description: 'Synthetic business', wp_url: 'https://wp.example' }),
    }),
    cookies: {}, redirect: (url: string) => new Response(null, { status: 302, headers: { location: url } }),
  } as never);
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toMatch(/^\/app\/sites\/acme-[a-f0-9]{12}/);
  await expectOriginalPreserved();
});
