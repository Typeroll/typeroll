import { expect, it } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';

async function setup() {
  makeTmpFixtures(); await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  const { resolvePublicationVersion } = await import('../../lib/publishing/publication-version');
  const { vstore } = await import('../../lib/version-store');
  const store = getStore();
  await store.setDoc(paths.version('org', 'site', 'design'), { name: 'Design', kind: 'branch', base_version_id: 'main' });
  return { store, resolvePublicationVersion, vstore };
}

it('freezes the selected branch including inherited blocks, templates, partials and collection items', async () => {
  const { store, resolvePublicationVersion, vstore } = await setup();
  await store.setDoc(paths.page('org', 'site', 'home', 'main'), { title: 'Main', status: 'published', content_mode: 'blocks', blocks: [{ id: 'heading', type: 'custom-heading', data: { text: 'Main' } }] });
  await store.setDoc(paths.page('org', 'site', 'home', 'design'), { title: 'Design', status: 'published', content_mode: 'blocks', blocks: [{ id: 'heading', type: 'custom-heading', data: { text: 'Design' } }] });
  await store.setDoc(paths.blockType('org', 'site', 'custom-heading', 'main'), { name: 'custom-heading', template: '<h1>Main template</h1>' });
  await store.setDoc(paths.blockType('org', 'site', 'custom-heading', 'design'), { name: 'custom-heading', template: '<h2>Branch template</h2>' });
  await store.setDoc(paths.pageTemplate('org', 'site', 'article', 'main'), { name: 'article', status: 'active' });
  await store.setDoc(paths.partial('org', 'site', 'footer', 'main'), { html_content: 'Inherited footer', status: 'published' });
  await store.setDoc(paths.settings('org', 'site', 'main'), { site_name: 'Main' });
  await store.setDoc(paths.settings('org', 'site', 'design'), { site_name: 'Design' });
  await store.setDoc(paths.collection('org', 'site', 'posts', 'main'), { name: 'posts', fields: [] });
  await store.setDoc(paths.collectionItem('org', 'site', 'posts', 'one', 'main'), { title: 'Main item' });
  await store.setDoc(paths.collectionItem('org', 'site', 'posts', 'one', 'design'), { title: 'Design item' });
  await store.setDoc(paths.page('org', 'site', 'removed', 'main'), { title: 'Still on main', status: 'published' });
  await vstore.deletePage('org', 'site', 'design', 'removed');
  const design = await resolvePublicationVersion('org', 'site', 'design');
  const main = await resolvePublicationVersion('org', 'site', 'main');
  expect(design.pages.map(p => p.title)).toEqual(['Design']);
  expect(design.pages[0].blocks?.[0].data.text).toBe('Design');
  expect(design.blockTypes[0].template).toContain('Branch template');
  expect(design.pageTemplates[0].name).toBe('article');
  expect(design.partials[0].html_content).toBe('Inherited footer');
  expect(design.settings?.site_name).toBe('Design');
  expect(design.collections[0].items[0].title).toBe('Design item');
  expect(main.pages.map(p => p.title).sort()).toEqual(['Main', 'Still on main']);
  expect(main.blockTypes[0].template).toContain('Main template');
  expect(main.settings?.site_name).toBe('Main');
  expect(main.collections[0].items[0].title).toBe('Main item');
  await store.setDoc(paths.page('org', 'site', 'home', 'design'), { title: 'Later edit' });
  expect(design.pages[0].title).toBe('Design');
});

it('rejects missing branches and cyclic or deleted bases instead of exporting main', async () => {
  const { store, resolvePublicationVersion } = await setup();
  await expect(resolvePublicationVersion('org', 'site', 'missing')).rejects.toThrow('no longer exists');
  await store.updateDoc(paths.version('org', 'site', 'design'), { base_version_id: 'missing' });
  await expect(resolvePublicationVersion('org', 'site', 'design')).rejects.toThrow('no longer exists');
  await store.updateDoc(paths.version('org', 'site', 'design'), { base_version_id: 'design' });
  await expect(resolvePublicationVersion('org', 'site', 'design')).rejects.toThrow('version chain');
});
