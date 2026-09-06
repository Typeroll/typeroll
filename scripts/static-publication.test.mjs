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
  for (const key of ['forms', 'extensions', 'collections', 'blockTypes', 'pageTemplates', 'redirects']) {
    assert.throws(() => projectStaticPublication({ ...input(), [key]: [{ id: 'feature' }] }, identity), /does not support/);
  }
  assert.throws(() => projectStaticPublication({ ...input(), apps: { apps: { analytics: { enabled: true } } } }, identity), /Core modules/);
  const value = input(); value.pages[0].content_mode = 'blocks';
  assert.throws(() => projectStaticPublication(value, identity), /HTML/);
  const another = input(); another.settings.contact = { email: 'test@example.invalid' };
  assert.throws(() => projectStaticPublication(another, identity), /does not yet project contact/);
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
  assert.ok(!result.stderr.includes('Package-manager shim must not run'));
});
