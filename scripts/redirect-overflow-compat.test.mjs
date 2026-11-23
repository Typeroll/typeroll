// The current frozen renderer must produce output an unmodified older
// supervisor accepts. Reading pinned Git source is offline; CI fetches tags.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStaticPublicationProject, projectStaticPublication, sealPublicationProject } from './lib/static-publication.mjs';
import { pagesBulkRedirects } from '../packages/shared/src/pages-redirect-overflow.mjs';

test('a full overflow publication passes the Core 0.3.44 static supervisor unchanged', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'typeroll-redirect-compat-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const files = ['packages/portal/src/lib/builds/direct-upload.mjs', 'packages/portal/src/lib/builds/contract.mjs', 'packages/shared/src/pages-redirect-limits.mjs'];
  for (const file of files) {
    const destination = path.join(temp, 'old-engine', file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, execFileSync('git', ['show', `core-v0.3.44:${file}`], { cwd: root }));
  }
  const { describeStaticOutput } = await import(pathToFileURL(path.join(temp, 'old-engine', files[0])).href);
  const redirects = Array.from({ length: 2200 }, (_, i) => ({ id: `r-${i}`, from_path: `/legacy-${i}.html`, to_path: '/', status_code: 301 }));
  redirects.push({ id: 'short', from_path: '/old', to_path: '/', status_code: 301 },
    { id: 'slash', from_path: '/old/', to_path: '/?slash=1', status_code: 302 },
    { id: 'pattern', from_path: '/category/*', to_path: '/', status_code: 301 },
    { id: 'query', from_path: '/?p=1', to_path: '/?article=1', status_code: 301 });
  const publication = projectStaticPublication({ site: { name: 'Synthetic migration', domain: 'example.invalid' },
    settings: { site_name: 'Synthetic migration', fonts: { heading: 'system-ui', body: 'system-ui' } },
    pages: [{ id: 'home', slug: '', title: 'Home', status: 'published', content_mode: 'html', html_content: '<h1>Home</h1><p>Public site.</p>' }],
    partials: [], forms: [], extensions: [], contentTypes: [], blockTypes: [], pageTemplates: [], menus: [], snippets: [], media: [], redirects,
  }, { siteUrl: 'https://example.invalid', coreCommit: 'a'.repeat(40), publishedAt: '2026-11-22T12:00:00Z' });
  publication.bulk_redirects_enabled = true;
  const project = path.join(temp, 'publication');
  await createStaticPublicationProject(publication, project);
  await fs.symlink(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  await fs.writeFile(path.join(project, 'package-lock.json'), '{"lockfileVersion":3}');
  await sealPublicationProject(project);
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: project, env: { PATH: process.env.PATH, ASTRO_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 90000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const description = await describeStaticOutput(path.join(project, 'dist'));
  const text = Buffer.from(description.controls._redirects, 'base64').toString('utf8');
  const overflow = pagesBulkRedirects(text);
  assert.equal(overflow.length, 204);
  assert.equal(text.split('\n').filter(line => line.startsWith('/') && !line.includes('*')).length, 2000);
  assert.ok(!Object.keys(description.files).some(name => name === '_worker.js' || name.startsWith('functions/')));
  assert.ok(text.includes('/category/* / 301'));
  assert.ok((await fs.readFile(path.join(project, 'dist/index.html'), 'utf8')).includes('article=1'));
});
