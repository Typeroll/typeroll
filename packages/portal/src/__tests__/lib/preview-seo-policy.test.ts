import { beforeEach, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
it('preview uses content-type routes, canonical overrides and independent robots', async () => {
  const { getStore } = await import('../../lib/datastore');
  const { renderPreview } = await import('../../lib/render-preview');
  const store = getStore();
  await store.setDoc(paths.site('org', 'site'), { name: 'Example', domain: 'example.test' });
  await store.setDoc(paths.settings('org', 'site', 'main'), { site_name: 'Example', trailing_slash: 'always' });
  await store.setDoc(paths.contentType('org', 'site', 'supplier', 'main'), { id: 'supplier', name: 'supplier', label_singular: 'Company', label_plural: 'Companies', route_template: '/companies/{slug}/', fields: [] });
  await store.setDoc(paths.page('org', 'site', 'companies', 'main'), { id: 'companies', slug: 'companies', title: 'Companies', status: 'published', content_mode: 'html', html_content: '<h1>Companies</h1>' });
  const pagePath = paths.page('org', 'site', 'abc', 'main');
  await store.setDoc(pagePath, { id: 'abc', slug: 'abc', title: 'ABC', content_type: 'supplier', status: 'published', content_mode: 'html', html_content: '<h1>ABC</h1>', noindex: true });
  let html = await renderPreview('org', 'site', 'abc', 'main');
  expect(html).toContain('content="noindex,follow"');
  expect(html).toContain('href="https://example.test/companies/abc/"');
  const crumbs = [...html!.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map(m => JSON.parse(m[1])).filter(ld => ld['@type'] === 'BreadcrumbList');
  expect(crumbs).toHaveLength(1);
  expect(crumbs[0].itemListElement.map((item: { item: string }) => item.item)).toEqual(['https://example.test/', 'https://example.test/companies/', 'https://example.test/companies/abc/']);
  await store.updateDoc(pagePath, { nofollow: true, canonical_url: 'https://original.test/abc/' });
  html = await renderPreview('org', 'site', 'abc', 'main');
  expect(html).toContain('content="noindex,nofollow"');
  expect(html).toContain('href="https://original.test/abc/"');
  await store.updateDoc(pagePath, { noindex: false, nofollow: false });
  await store.setDoc(paths.version('org', 'site', 'review'), { name: 'Review', kind: 'branch', base_version_id: 'main', robots_blocked: true });
  expect(await renderPreview('org', 'site', 'abc', 'review')).toContain('content="noindex,nofollow"');
});
