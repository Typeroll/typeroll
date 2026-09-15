import { beforeEach, expect, it } from 'vitest';
import { paths, defaultSiteSettings } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { loadDesignContext } from '../../lib/wp/design-context';

beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
it('uses block based design references and inherited settings in the selected version', async () => {
  const store = getStore();
  await store.setDoc(paths.settings('org', 'site', 'main'), { ...defaultSiteSettings, site_name: 'Original' });
  await store.setDoc(paths.version('org', 'site', 'redesign'), { base_version_id: 'main', kind: 'branch' });
  const page = { title: 'Home', slug: '', status: 'published', content_mode: 'blocks', blocks: [{ id: 'content', type: 'core/prose', data: { html: '<p>A complete block based design reference with enough original content to guide the import faithfully and preserve the intended layout.</p>' } }] };
  await store.setDoc(paths.page('org', 'site', 'home', 'main'), page);
  await store.setDoc(paths.page('org', 'site', 'home', 'redesign'), { ...page, title: 'Redesigned Home' });
  const branch = await loadDesignContext('org', 'site', 'redesign');
  expect(branch.site_name).toBe('Original');
  expect(branch.example_pages[0].title).toBe('Redesigned Home');
  expect(branch.example_pages[0].html).toContain('block based design reference');
  expect((await loadDesignContext('org', 'site')).example_pages[0].title).toBe('Home');
});
