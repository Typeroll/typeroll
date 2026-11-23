import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ baseline: null as any, failure: false, read: vi.fn(async () => ({ last_publication: 'verified-one' })) }));
vi.mock('../../lib/datastore', () => ({ getStore: () => ({ getDoc: state.read }) }));
vi.mock('../../lib/publishing/impact-preview', () => ({ verifiedBaseline: async () => { if (state.failure) throw Error('Corrupt snapshot; PRIVATE diagnostic'); return state.baseline; } }));
vi.mock('../../lib/api-auth', async load => ({ ...await load<object>(), requireApiKey: async (request: Request) => ({ ok: true, value: {
  orgId: 'org', siteId: 'site', versionId: 'main', permission: 'read', request, path: new URL(request.url).pathname,
} }) }));
import { GET } from '../../pages/api/v1/sites/[siteId]/pages/[pageId]/published';
beforeEach(() => { vi.clearAllMocks(); state.failure = false; state.baseline = { snapshot: {}, publication_id: 'verified-one', publication: {
  site_url: 'https://site.example.test', pages: [{ id: 'company', title: 'Verified published title', status: 'published', slug: 'company', fields: { pending_contact: 'PRIVATE' } }],
} }; });
const call = () => GET({ request: new Request('https://cms.example.test/api/v1/sites/site/pages/company/published'), params: { siteId: 'site', pageId: 'company' } } as never);
it('reads the verified frozen source without fetching current Pages or working copies', async () => {
  const response = await call(); expect(response.status).toBe(200); const data = await response.json();
  expect(data).toMatchObject({ publication_id: 'verified-one', page: { title: 'Verified published title', fields: {} } });
  expect(JSON.stringify(data)).not.toContain('PRIVATE');
  expect(state.read.mock.calls).toEqual([['organizations/org/sites/site/publishing_targets/main']]);
});
it('refuses a missing or corrupt verified baseline instead of substituting draft facts', async () => {
  state.baseline.snapshot = null; expect((await call()).status).toBe(404);
  state.failure = true; const response = await call(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
});
