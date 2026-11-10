import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { projectStaticPublication } from './lib/static-publication.mjs';
import { publicationBuildHarness } from './lib/publication-build-harness.mjs';

const bundle = await build({ stdin: { contents: "export { CORE_BLOCK_TYPES } from './packages/shared/src/core-blocks.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { CORE_BLOCK_TYPES } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

// A header banner that is primary on the home page and secondary elsewhere,
// shaped like the one that shipped secondary everywhere: nested in a container,
// with a custom class, render version 16, and a home page on a page template.
// The portal preview rendered it right; the publication projection dropped
// route_overrides, so only the full CMS → publication → frozen build path shows it.
test('route_overrides in a header partial reach the published static build', async t => {
  const page = (id, extra = {}) => ({ id, slug: id, title: `${id} title`, status: 'published', content_mode: 'blocks',
    blocks: [{ id: `${id}-body`, type: 'core/prose', data: { html: `<p>${id} text</p>` } }], ...extra });
  const header = { id: 'header', name: 'Main header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [{
    id: 'banner-shadow', type: 'core/container', data: { width: 'full', direction: 'column', gap: 'none' }, children: [{
      id: 'banner-surface', type: 'core/section', data: { width: 'full', background: 'var(--color-secondary)', text_color: 'on_secondary' },
      style_overrides: { custom_class: 'header-banner' },
      route_overrides: { home: { data_overrides: { background: 'var(--color-primary)' } } },
      children: [{ id: 'banner-text', type: 'core/prose', data: { html: '<p>Route banner</p>' } }],
    }],
  }] };
  const input = {
    site: { name: 'Example' }, settings: { site_name: 'Example', trailing_slash: 'always', render_version: 16 },
    pages: [page('home', { path: '/', template: 'home-template' }), page('contact')],
    pageTemplates: [{ id: 'home-template', status: 'published', blocks: [{ id: 'slot', type: 'template_content_slot', data: {} }] }],
    partials: [header], media: [], forms: [], extensions: [], contentTypes: [], blockTypes: [], redirects: [],
  };
  const identity = { siteUrl: 'https://example.invalid', coreCommit: 'd'.repeat(40), publishedAt: '2026-11-10T15:44:00Z', noindex: false, coreBlockTypes: CORE_BLOCK_TYPES };
  const publication = projectStaticPublication(input, identity);
  const harness = await publicationBuildHarness(publication);
  t.after(harness.cleanup);
  const banner = async route => {
    const html = await fs.readFile(path.join(harness.destination, 'dist', route), 'utf8');
    const tag = html.match(/<section[^>]*data-source-block-id="banner-surface"[^>]*>/)?.[0];
    assert.ok(tag, `${route} has no header banner`);
    return tag;
  };
  await harness.run();
  assert.match(await banner('index.html'), /--block-bg:var\(--color-primary\)/);
  assert.match(await banner('contact/index.html'), /--block-bg:var\(--color-secondary\)/);

  // A warm rebuild after editing only the override renders every route again.
  publication.partials[0].blocks[0].children[0].route_overrides.home.data_overrides.background = 'var(--color-accent)';
  assert.equal((await harness.run()).report.reused, 0);
  assert.match(await banner('index.html'), /--block-bg:var\(--color-accent\)/);
  assert.match(await banner('contact/index.html'), /--block-bg:var\(--color-secondary\)/);
});
