import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStaticPublicationProject, projectStaticPublication, sealPublicationProject } from './lib/static-publication.mjs';

// Authored text naming the site: from render version 15 a frozen publication
// expands {{site.name}} and {{site.fields.<name>}} (the publication's frozen
// site field values, escaped) in HTML pages, block text and global blocks.
// Render version 14 keeps them as written in HTML pages and global blocks,
// byte for byte as before.
test('a publication expands {{site.name}} and {{site.fields.*}} from render version 15 only', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-authored-variables-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const build = async (renderVersion) => {
    const input = {
      site: { name: 'Bistro', domain: 'bistro.test' },
      settings: { site_name: 'Bistro <Lykta>', language: 'sv', render_version: renderVersion },
      pages: [
        { id: 'home', title: 'Home', slug: '', status: 'published', content_mode: 'html', html_content: '<h1>Home</h1><p>Welcome to {{site.name}}. Call {{site.fields.phone}}. © {{site.current_year}}</p>' },
        { id: 'menu', title: 'Menu', slug: 'menu', status: 'published', content_mode: 'blocks', blocks: [{ id: 'intro', type: 'core/prose', data: { html: '<p>{{site.name}} serves {{site.fields.seats}} guests.</p>' } }] },
      ],
      partials: [{ id: 'footer', kind: 'footer', status: 'published', content_mode: 'html', html_content: '<p>{{site.name}} · {{site.fields.phone}}</p>' }],
      siteFields: { groups: [{ id: 'contact', fields: [{ name: 'phone', type: 'text' }, { name: 'seats', type: 'number' }] }], values: { phone: '08-123 <45>', seats: 30 } },
      contentTypes: [], forms: [], extensions: [], blockTypes: [], pageTemplates: [], media: [], redirects: [],
    };
    const publication = projectStaticPublication(input, { siteUrl: 'https://bistro.test', coreCommit: 'b'.repeat(40), publishedAt: '2026-11-07T00:00:00Z', noindex: false,
      coreBlockTypes: [{ id: 'core/prose', schema: [{ name: 'html', type: 'richtext' }] }] });
    // Frozen font files, as Typeroll freezes them with a publication: the build must not download Inter.
    const bytes = Buffer.from('frozen font bytes'), name = `${'f'.repeat(32)}.woff2`;
    publication.theme_fonts = { css_url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap', css: `@font-face{font-family:'Inter';src:url(/_typeroll/fonts/${name}) format('woff2')}\n`,
      files: [{ name, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }] };
    const destination = path.join(temp, `v${renderVersion}`);
    await createStaticPublicationProject(publication, destination);
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
    await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
    await sealPublicationProject(destination);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: {}, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return {
      home: await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8'),
      menu: await fs.readFile(path.join(destination, 'dist/menu/index.html'), 'utf8'),
    };
  };
  const year = new Date().getUTCFullYear();
  const v15 = await build(15);
  assert.ok(v15.home.includes(`Welcome to Bistro &lt;Lykta&gt;. Call 08-123 &lt;45&gt;. © ${year}`), v15.home);
  assert.ok(v15.home.includes('Bistro &lt;Lykta&gt; · 08-123 &lt;45&gt;'));
  assert.ok(v15.menu.includes('Bistro &lt;Lykta&gt; serves 30 guests.'));
  for (const html of [v15.home, v15.menu]) assert.ok(!/\{\{\s*site\./.test(html));
  const v14 = await build(14);
  assert.ok(v14.home.includes(`Welcome to {{site.name}}. Call {{site.fields.phone}}. © ${year}`));
  assert.ok(v14.home.includes('<p>{{site.name}} · {{site.fields.phone}}</p>'));
});
