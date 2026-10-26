import { beforeEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

const orgId = 'test-org', siteId = 'test-site', versionId = 'main', pageId = 'about';

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore(); vi.resetModules();
  vi.doMock('../../lib/access', async () => ({
    ...await vi.importActual<any>('../../lib/access'),
    requireSiteAccess: async () => ({ ok: true, value: { session: { userId: 'editor', email: 'editor@example.invalid' }, site: { id: siteId }, owner_org_id: orgId, versionId, permission: 'write' } }),
  }));
});

it('stores sanitized HTML when a page is saved from the portal', async () => {
  const { getStore } = await import('../../lib/datastore');
  const store = getStore();
  await store.setDoc(paths.contentType(orgId, siteId, 'page', versionId), { name: 'page', fields: [], route_template: '/{slug}' });
  await store.setDoc(paths.page(orgId, siteId, pageId, versionId), { title: 'About', slug: 'about', content_mode: 'html', status: 'draft', html_content: '<p>Old</p>' });
  const { PUT } = await import('../../pages/api/sites/[siteId]/pages/[pageId]');
  const body = { html_content: '<p>Hello</p><img src="x" onerror="alert(1)"><script>alert(2)</script>' };
  const response = await PUT({ params: { siteId, pageId }, locals: {}, cookies: {}, request: new Request('https://example.invalid/api/pages/about', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) } as any);
  expect(response.status).toBe(200);
  const saved = await store.getDoc<{ html_content: string }>(paths.page(orgId, siteId, pageId, versionId));
  expect(saved?.html_content).toContain('<p>Hello</p>');
  expect(saved?.html_content).not.toMatch(/onerror|<script/i);
});
