import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const orgId = 'test-org', siteId = 'test-site', versionId = 'main', pageId = 'deep';
function deepPage() {
  let block: any = { id: 'leaf', type: 'core/container', data: { background_gradient: { from: '#ffffff', to: '#eeeeee' } } };
  for (let n = 0; n < 8; n++) block = { id: `group-${n}`, type: 'core/container', data: {}, children: [block] };
  return { title: 'Deep page', slug: 'deep', content_mode: 'blocks', status: 'published', blocks: [block], fields: { retained: 'keep me' } };
}

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.resetModules();
  vi.doMock('../../lib/access', async () => ({
    ...await vi.importActual<any>('../../lib/access'),
    requireSiteAccess: async () => ({ ok: true, value: { session: { userId: 'owner', email: 'owner@example.invalid' }, site: { id: siteId }, owner_org_id: orgId, versionId, permission: 'admin' } }),
  }));
});

it('saves an existing deep Page and restores its revision through ordinary routes', async () => {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.contentType(orgId, siteId, 'page', versionId), { name: 'page', fields: [], route_template: '/{slug}', page_field_rules: { title: { writable_by: ['portal', 'agent'] } } });
  const original = deepPage();
  await store.setDoc(paths.page(orgId, siteId, pageId, versionId), original);
  const args = (method: string, body: unknown) => ({ params: { siteId, pageId }, locals: {}, cookies: {}, request: new Request('https://example.invalid/api/pages/deep', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) }) as any;
  const { PUT } = await import('../../pages/api/sites/[siteId]/pages/[pageId]');
  expect((await PUT(args('PUT', { title: 'Changed title' }))).status).toBe(200);
  const { listRevisions } = await import('../../lib/revisions');
  const revisions = await listRevisions({ orgId, siteId, versionId, kind: 'page', resourceIds: [pageId] });
  expect(revisions[0].doc).toMatchObject(original);
  const saved = await store.getDoc<any>(paths.page(orgId, siteId, pageId, versionId));
  expect(saved.fields).toEqual(original.fields);
  expect(saved._provenance.title).toMatchObject({ source: 'portal', actor: 'owner' });
  const { POST } = await import('../../pages/api/sites/[siteId]/pages/[pageId]/revisions');
  expect((await POST(args('POST', { revId: revisions[0].id }))).status).toBe(200);
  expect(await store.getDoc(paths.page(orgId, siteId, pageId, versionId))).toMatchObject(original);
  expect((await listRevisions({ orgId, siteId, versionId, kind: 'page', resourceIds: [pageId] })).length).toBe(2);
});
