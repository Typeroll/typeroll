import { afterEach, expect, it, vi } from 'vitest';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { renderPreviewBySlug } from '../../lib/render-preview';

afterEach(() => vi.restoreAllMocks());

it('reads route collections once and overlaps independent preview inputs without reusing stale content', async () => {
  makeTmpFixtures(); await resetDatastore();
  const org = 'preview-org', site = 'preview-site', version = MAIN_VERSION_ID;
  await getStore().setDoc(paths.site(org, site), { name: 'Preview performance' });
  await getStore().setDoc(paths.settings(org, site, version), { site_name: 'Preview performance' });
  await getStore().setDoc(paths.page(org, site, 'home', version), { title: 'First title', slug: 'home', path: '/', content_type: 'page', content_mode: 'html', html_content: '<p>Saved content</p>', status: 'published' });
  const pages = vi.spyOn(vstore, 'pages');
  const types = vi.spyOn(vstore, 'contentTypes');
  const originalSettings = vstore.settings;
  const originalPartials = vstore.partials;
  let settingsStarted = false, partialsStarted = false;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(vstore, 'settings').mockImplementation(async (...args) => {
    settingsStarted = true;
    if (partialsStarted) release();
    await barrier;
    return originalSettings(...args);
  });
  vi.spyOn(vstore, 'partials').mockImplementation(async (...args) => {
    partialsStarted = true;
    if (settingsStarted) release();
    await barrier;
    return originalPartials(...args);
  });
  const html = await renderPreviewBySlug(org, site, [], version);
  expect(html).toContain('<title>First title</title>');
  expect(pages).toHaveBeenCalledTimes(1);
  expect(types).toHaveBeenCalledTimes(1);
  await getStore().updateDoc(paths.page(org, site, 'home', version), { title: 'Changed title' });
  expect(await renderPreviewBySlug(org, site, [], version)).toContain('<title>Changed title</title>');
  expect(pages).toHaveBeenCalledTimes(2);
});
