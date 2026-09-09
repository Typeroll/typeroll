import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectStaticPublication, createStaticPublicationProject, sealPublicationProject } from './lib/static-publication.mjs';

function input() {
  return {
    site: { name: 'Synthetic Site', domain: 'example.invalid', hosting_config: { token: 'private-value' } },
    settings: { site_name: 'Synthetic Site', colors: { primary: '#112233', private: 'private-value' }, fonts: { heading: 'Arial', body: 'Arial', size_base: 16 }, _internal: 'private-value' },
    pages: [
      { id: 'home', slug: '', title: 'Home', status: 'published', content_mode: 'html', html_content: '<h1>Public</h1><img src="https://media.example.invalid/one.png" />', api_generated: true, editor_email: 'private-value' },
      { id: 'draft', slug: 'draft', status: 'draft', content_mode: 'html', html_content: 'private-value' },
    ],
    partials: [{ id: 'footer', name: 'Footer', kind: 'footer', status: 'published', content_mode: 'html', html_content: '<footer>Public footer</footer>', working_copy: 'private-value' }],
    media: [
      { id: 'image', filename: 'one.png', cdn_url: 'https://media.example.invalid/one.png', width: 64, height: 32, uploaded_by: 'private-value', r2_key: 'private-value', variants: [{ cdn_url: 'https://media.example.invalid/one.webp', format: 'webp', width: 64, size_bytes: 100, internal: 'private-value' }] },
      { id: 'unused', filename: 'private.png', cdn_url: 'https://media.example.invalid/private.png', title: 'private-value' },
    ],
    forms: [], extensions: [], collections: [], blockTypes: [], pageTemplates: [], redirects: [], apps: null,
  };
}
const identity = { siteUrl: 'https://example.invalid', coreCommit: 'a'.repeat(40), publishedAt: '2026-09-06T12:00:00Z' };

test('publishes optional page fields cleared by a full API replacement without accepting malformed values', () => {
  const value = input();
  Object.assign(value.pages[0], { noindex: null, alternates: null, blocks: null, template: null, seo_title: null });
  const publication = projectStaticPublication(value, identity);
  assert.equal(publication.pages[0].html_content, value.pages[0].html_content);
  assert.ok(!Object.hasOwn(publication.pages[0], 'noindex'));
  assert.ok(!Object.hasOwn(publication.pages[0], 'alternates'));
  value.pages[0].noindex = 'false';
  assert.throws(() => projectStaticPublication(value, identity), /Invalid public flag: noindex/);
  value.pages[0].noindex = false; value.pages[0].alternates = 'invalid';
  assert.throws(() => projectStaticPublication(value, identity), /Invalid publication language alternatives/);
});

const coreBlockTypes = [
  { id: 'core/section', schema: [{ name: 'background', type: 'color' }] },
  { id: 'core/heading', schema: [{ name: 'text', type: 'text' }, { name: 'level', type: 'select' }, { name: 'editor_note', type: 'text', rendered: false }] },
];

test('block publication preserves nested responsive content and excludes editorial data', () => {
  const value = input();
  value.pages[0] = { ...value.pages[0], content_mode: 'blocks', custom_css: 'h1 { color: blue; }', blocks: [{
    id: 'section-one', type: 'core/section', name: 'private-value', data: { background: '#fff', unknown: 'private-value' },
    children: [{ id: 'heading-one', type: 'core/heading', data: { text: 'Block publication', level: 'h1', editor_note: 'private-value' },
      responsive: { mobile: { hidden: false, data_overrides: { text: 'Mobile title', editor_note: 'private-value' } } },
      style_overrides: { custom_class: 'public-heading', editor: 'private-value' } }],
  }] };
  delete value.pages[0].html_content;
  const publication = projectStaticPublication(value, { ...identity, coreBlockTypes });
  assert.equal(publication.pages[0].blocks[0].children[0].data.text, 'Block publication');
  assert.equal(publication.pages[0].blocks[0].children[0].responsive.mobile.data_overrides.text, 'Mobile title');
  assert.equal(publication.pages[0].custom_css, 'h1 { color: blue; }');
  assert.ok(!JSON.stringify(publication).includes('private-value'));
  value.pages[0].blocks[0].children[0].type = 'unknown/backend';
  assert.throws(() => projectStaticPublication(value, { ...identity, coreBlockTypes }), /Unsupported publication block/);
});

test('public projection removes private fields, drafts, internal nested data and unused media', () => {
  const projected = projectStaticPublication(input(), identity);
  assert.equal(projected.pages.length, 1);
  assert.equal(projected.media.length, 1);
  assert.equal(projected.media[0].variants[0].cdn_url, 'https://media.example.invalid/one.webp');
  assert.equal(projected.settings.colors.primary, '#112233');
  assert.equal(projected.settings.sitewide_noindex, true);
  assert.ok(!JSON.stringify(projected).includes('private-value'));
  assert.ok(!JSON.stringify(projected).includes('api_generated'));
});

test('unsupported modules and data structures fail instead of silently losing site behavior', () => {
  for (const key of ['forms', 'extensions']) {
    assert.throws(() => projectStaticPublication({ ...input(), [key]: [{ id: 'feature' }] }, identity), /public runtime projection/);
  }
  assert.throws(() => projectStaticPublication({ ...input(), collections: [{ id: 'feature' }] }, identity), /Invalid publication collection/);
  assert.throws(() => projectStaticPublication({ ...input(), apps: { apps: { analytics: { enabled: true } } } }, identity), /Core modules/);
  const value = input(); value.pages[0].content_mode = 'blocks';
  assert.throws(() => projectStaticPublication(value, identity), /HTML/);
});

test('projects nested public settings and permits publication after the last page is removed', () => {
  const value = input(); value.pages = [];
  value.settings.contact = { email: 'public@example.invalid', address: { address_locality: 'Example town', internal: 'private-value' }, billing_email: 'private-value' };
  value.settings.social = { linkedin: 'https://example.invalid/profile', internal: 'private-value' };
  value.settings.organization = { name: 'Public company', same_as: ['https://example.invalid/profile'], internal: 'private-value' };
  value.settings.cookie_consent = { enabled: true, text: 'Public consent', scripts_optional: '<script>window.example=true</script>', internal: 'private-value' };
  const publication = projectStaticPublication(value, identity);
  assert.deepEqual(publication.pages, []);
  assert.deepEqual(publication.settings.contact, { email: 'public@example.invalid', address: { address_locality: 'Example town' } });
  assert.equal(publication.settings.cookie_consent.scripts_optional, '<script>window.example=true</script>');
  assert.ok(!JSON.stringify(publication).includes('private-value'));
  assert.match(publication.publication_id, /^[a-f0-9]{64}$/);
});

test('publication rejects unsafe document paths and expiring credential-bearing media URLs', () => {
  const value = input(); value.pages[0].id = '../outside';
  assert.throws(() => projectStaticPublication(value, identity), /document ID/);
  const media = input();
  media.media[0].variants[0].cdn_url += '?X-Amz-Signature=not-permanent';
  assert.throws(() => projectStaticPublication(media, identity), /permanent HTTPS/);
});

test('generated projects contain real renderer source, no Firebase dependency and an enforceable file manifest', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-publication-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const destination = path.join(tmp, 'site');
  await createStaticPublicationProject(projectStaticPublication(input(), identity), destination);
  const template = JSON.parse(await fs.readFile(path.join(destination, 'packages/site-template/package.json'), 'utf8'));
  assert.equal(template.dependencies['firebase-admin'], undefined);
  const store = await fs.readFile(path.join(destination, 'packages/site-template/src/lib/datastore.ts'), 'utf8');
  assert.ok(!store.includes('firebase-admin'));
  assert.ok(store.includes('frozen publication fixture directory'));
  await assert.rejects(sealPublicationProject(destination), /dependency lock/);
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  const sealed = await sealPublicationProject(destination);
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'publication-manifest.json'), 'utf8'));
  assert.ok(manifest.files['packages/site-template/src/pages/[...slug].astro']);
  assert.ok(manifest.files['scripts/source/bundle-blocks.ts']);
  assert.ok(manifest.files['scripts/source/search-index.ts']);
  assert.ok(manifest.files['publication.json']);
  assert.equal(sealed.files, Object.keys(manifest.files).length);
  await assert.rejects(createStaticPublicationProject(projectStaticPublication(input(), identity), destination), { code: 'EEXIST' });
});

test('generated renderer builds with no HOME and an unusable package-manager shim', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-build-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const destination = path.join(tmp, 'site');
  await createStaticPublicationProject(projectStaticPublication(input(), identity), destination);
  // Reuse the test environment's installed dependencies without a network install.
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  await sealPublicationProject(destination);
  const shims = path.join(tmp, 'shims');
  await fs.mkdir(shims);
  await fs.writeFile(path.join(shims, 'npm'), '#!/bin/sh\necho "Package-manager shim must not run" >&2\nexit 93\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: destination, env: { PATH: shims }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const html = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
  assert.match(html, /<h1>Public<\/h1>/);
  const marker = JSON.parse(await fs.readFile(path.join(destination, 'dist/.well-known/typeroll/publication.json'), 'utf8'));
  assert.deepEqual(marker.paths, ['/']);
  assert.match(await fs.readFile(path.join(destination, 'dist/_headers'), 'utf8'), new RegExp('X-Typeroll-Publication: ' + marker.id));
  assert.ok(!result.stderr.includes('Package-manager shim must not run'));
});

test('real Core blocks build portable assets and last-page removal produces an empty publication marker', async (t) => {
  const { build } = await import('esbuild');
  const source = await build({ entryPoints: [fileURLToPath(new URL('../packages/shared/src/core-blocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { CORE_BLOCK_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-blocks-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const value = input();
  value.pages[0] = { ...value.pages[0], content_mode: 'blocks', blocks: [{
    id: 'public-section', type: 'core/section', data: { width: 'normal', padding_y: 'md' }, children: [{
      id: 'public-heading', type: 'core/heading', data: { text: 'Portable real Core blocks', level: 'h1', align: 'left', size: 'auto', editor_note: 'private-value' },
    }],
  }] };
  for (const [name, pages] of [['blocks', value.pages], ['branch', value.pages], ['empty', []]]) {
    const destination = path.join(tmp, name);
    const publication = projectStaticPublication({ ...value, pages }, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES, versionId: name === 'branch' ? 'design' : 'main', noindex: name !== 'branch' });
    await createStaticPublicationProject(publication, destination);
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
    await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
    await sealPublicationProject(destination);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: {}, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const marker = JSON.parse(await fs.readFile(path.join(destination, 'dist/.well-known/typeroll/publication.json'), 'utf8'));
    const headers = await fs.readFile(path.join(destination, 'dist/_headers'), 'utf8');
    assert.match(headers, /X-Robots-Tag: noindex, nofollow/);
    const patterns = headers.split('\n').filter(line => line && !/^\s|#/.test(line));
    assert.equal(patterns.filter(line => line === '/*').length, 1, 'Cloudflare keeps only the last rule for duplicate patterns');
    assert.ok(patterns.every(line => (line.match(/\*/g) ?? []).length <= 1), 'Cloudflare permits only one wildcard per header rule');
    assert.ok(patterns.includes('https://:project.pages.dev/*'));
    assert.ok(patterns.includes('https://:version.:project.pages.dev/*'));
    assert.equal(marker.id, publication.publication_id);
    if (name !== 'empty') {
      const html = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
      assert.match(html, /<h1[^>]*>Portable real Core blocks<\/h1>/);
      assert.match(html, /\[data-block="heading"\]/);
      assert.match(html, /\[data-block="section"\]/);
      assert.ok(!html.includes('private-value'));
      assert.deepEqual(marker.paths, ['/']);
      const expectedVersion = name === 'branch' ? 'design' : 'main';
      assert.equal(publication.version_id, expectedVersion);
      assert.equal(publication.git_branch, name === 'branch' ? 'version-design' : 'main');
      const frozen = JSON.parse(await fs.readFile(path.join(destination, `.publication-work/fixtures/organizations/default/sites/default/versions/${expectedVersion}/pages/home.json`), 'utf8'));
      assert.equal(frozen.blocks[0].children[0].data.text, 'Portable real Core blocks');
    } else {
      await assert.rejects(fs.readFile(path.join(destination, 'dist/index.html')), { code: 'ENOENT' });
      assert.deepEqual(marker.paths, ['/.well-known/typeroll/publication.json']);
    }
  }
});


test('a resolved branch cannot accidentally publish its frozen source as main', () => {
  const value = { ...input(), versionId: 'design' };
  const publication = projectStaticPublication(value, { ...identity, noindex: false });
  assert.equal(publication.version_id, 'design');
  assert.equal(publication.git_branch, 'version-design');
  assert.equal(publication.settings.sitewide_noindex, true);
  assert.notEqual(publication.publication_id, projectStaticPublication(input(), identity).publication_id);
  assert.throws(() => projectStaticPublication(value, { ...identity, versionId: 'main' }), /version mismatch/);
});


test('generated branch names accept version suffixes without allowing arbitrary Git refs', () => {
  const versionId = 'a'.repeat(48) + '-2';
  const publication = projectStaticPublication({ ...input(), versionId }, identity);
  assert.equal(publication.git_branch, `version-${versionId}`);
  for (const invalid of ['../main', 'refs/heads/main', 'Design', 'a'.repeat(129)]) {
    assert.throws(() => projectStaticPublication({ ...input(), versionId: invalid }, identity), /version ID/);
  }
});

test('frozen main and branch projects render their own custom blocks and inherited page templates', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-static-template-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  for (const versionId of ['main', 'design']) {
    const value = input();
    value.versionId = versionId;
    value.redirects = [{ id: 'old', from_path: '/old', to_path: `/${versionId}`, status_code: 301, internal: 'private-value' }, { id: 'shadow', from_path: '/', to_path: '/missing', status_code: 302 }];
    value.pages = [{ id: 'home', slug: '', title: 'Home', status: 'published', template: 'layout', content_mode: 'blocks', blocks: [
      { id: 'heading-one', type: 'custom-heading', data: { text: versionId + ' content', private_note: 'private-value' } },
    ] }];
    value.blockTypes = [
      { id: 'custom-heading', name: 'custom-heading', label: 'Heading', container: false, template: `<h2 data-version="${versionId}">{{text}}</h2>`, styles: 'h2 { color: blue; }',
        schema: [{ name: 'text', type: 'text' }, { name: 'private_note', type: 'text', rendered: false, default: 'private-value' }], imported_from: { author: 'private-value' } },
      { id: 'custom-frame', name: 'custom-frame', label: 'Frame', container: true, template: '<article data-layout="inherited">{{children}}</article>', schema: [] },
    ];
    value.pageTemplates = [
      { id: 'layout', name: 'Layout', status: 'published', blocks: [{ id: 'frame', type: 'custom-frame', data: {}, children: [{ id: 'content-slot', type: 'template_content_slot', data: {} }] }], created_by: 'private-value' },
      { id: 'draft-layout', name: 'private-value', status: 'draft', blocks: [] },
    ];
    const publication = projectStaticPublication(value, identity);
    assert.ok(!JSON.stringify(publication).includes('private-value'));
    assert.equal(publication.blockTypes[0].schema.length, 0); // deterministic ID order: frame before heading
    const destination = path.join(tmp, versionId);
    await createStaticPublicationProject(publication, destination);
    await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
    await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
    await sealPublicationProject(destination);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination, env: {}, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const html = await fs.readFile(path.join(destination, 'dist/index.html'), 'utf8');
    assert.ok(html.includes(`<h2 data-version="${versionId}">${versionId} content</h2>`));
    assert.ok(html.includes('<article data-layout="inherited">'));
    assert.ok(!html.includes(versionId === 'design' ? 'main content' : 'design content'));
    assert.match(html, /h2\s*\{\s*color:\s*blue/);
    const redirects = await fs.readFile(path.join(destination, 'dist/_redirects'), 'utf8');
    assert.ok(redirects.includes(`/old /${versionId}/ 301`));
    assert.ok(redirects.includes(`/old/ /${versionId}/ 301`));
    assert.ok(!redirects.includes('/missing'));
  }
});

test('portable source renders collections, form runtime and language metadata while excluding private actions', async t => {
  const { build } = await import('esbuild');
  const source = await build({ entryPoints: [fileURLToPath(new URL('../packages/shared/src/core-blocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  const { CORE_BLOCK_TYPES } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-public-runtime-'));
  const tmp = path.join(directory, 'site');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const value = input();
  value.pages[0].html_content = '<h1>Public runtime</h1><x-form id="contact" />';
  value.pages[0].alternates = [{ hreflang: 'sv', href: 'https://sv.example.invalid/' }];
  value.collections = [{ definition: { id: 'news', name: 'news', label_singular: 'News', label_plural: 'News', fields: [{ name: 'title', type: 'text' }, { name: 'slug', type: 'text' }, { name: 'body', type: 'richtext' }], item_template_html: '<h1>{{title}}</h1><div>{{{body}}}</div>' }, items: [{ id: 'article', title: 'Frozen collection article', slug: 'article', body: '<p>Portable article body</p>', status: 'published', internal_notes: 'private-value' }, { id: 'draft', status: 'draft', title: 'private-value' }] }];
  value.publicRuntime = { apps: { apps: {} }, extensions: { installations: [] }, forms: [{ id: 'contact', name: 'Contact', submit_text: 'Send request', submit_url: 'https://forms.example.invalid/submit/contact', submit_token: 'public-form-capability', pow_bits: 16, actions: [{ config: { token: 'private-value' } }], steps: [{ id: 'step-one', blocks: [{ id: 'field', type: 'form/text', data: { name: 'name', label: 'Your name' } }] }] }], dependencies: [{ kind: 'forms', id: 'contact', endpoint: 'https://forms.example.invalid/submit/contact' }] };
  const publication = projectStaticPublication(value, { ...identity, coreBlockTypes: CORE_BLOCK_TYPES });
  assert.ok(!JSON.stringify(publication).includes('private-value'));
  await createStaticPublicationProject(publication, tmp);
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(tmp, 'node_modules'), 'dir');
  await fs.writeFile(path.join(tmp, 'package-lock.json'), '{"lockfileVersion":3}');
  await sealPublicationProject(tmp);
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: tmp, env: {}, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const article = await fs.readFile(path.join(tmp, 'dist/news/article/index.html'), 'utf8');
  assert.match(article, /Frozen collection article/);
  assert.match(article, /Portable article body/);
  const home = await fs.readFile(path.join(tmp, 'dist/index.html'), 'utf8');
  assert.match(home, /hreflang="sv"/);
  assert.match(home, /forms.example.invalid/);
  assert.match(home, /Your name/);
  assert.match(home, /Send request/);
});
