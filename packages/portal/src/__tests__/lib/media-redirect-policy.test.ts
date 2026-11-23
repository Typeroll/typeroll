import { expect, it } from 'vitest';
import { expandRedirectsForTrailingSlashPolicy, pagesRedirectCapacity, pagesRedirectsFile, type Redirect } from '@typeroll/shared';
import { compactCoveredMediaRedirects, freezeMediaRedirects } from '../../lib/publishing/media-redirect-policy';
import { authoredMediaContent } from '../../lib/publishing/media-manifest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectStaticPublication } from '../../../../../scripts/lib/static-publication.mjs';
import { publicationBuildHarness } from '../../../../../scripts/lib/publication-build-harness.mjs';

const rule = (from_path: string, to_path: string, status_code: 301 | 302 = 301): Redirect => ({ id: `r-${from_path.replace(/[^A-Za-z0-9_.-]/g, '_')}`, from_path, to_path, status_code });
const prefix = rule('/media/*', 'https://images.example.com/:splat');

it('publishes thousands of unchanged image paths through one existing prefix without deleting authored rules', () => {
  const original = Array.from({ length: 2500 }, (_, i) => rule(`/media/image-${i}.jpg`, `https://images.example.com/image-${i}.jpg`));
  original.push(prefix, rule('/media/special.jpg', 'https://images.example.com/replacement.jpg'), rule('/media/temporary.jpg', 'https://images.example.com/temporary.jpg', 302));
  const before = structuredClone(original);
  const compact = compactCoveredMediaRedirects(original);
  expect(compact).toHaveLength(3);
  expect(compact).toEqual(original.slice(-3));
  expect(original).toEqual(before);
  expect(pagesRedirectCapacity(compact)).toMatchObject({ static: 4, dynamic: 1, bulk_required: false, over_limit: false });
  const text = pagesRedirectsFile(compact);
  expect(text).toContain('/media/* https://images.example.com/:splat 301');
  const lines = text.trim().split('\n').map(line => line.split(/\s+/));
  for (const authored of original.filter(item => !item.from_path.includes('*'))) {
    let observed: { target: string; status: number } | null = null;
    for (const [source, target, status] of lines) {
      if (source === authored.from_path) { observed = { target, status: Number(status) }; break; }
      if (source.endsWith('/*') && authored.from_path.startsWith(source.slice(0, -1))) {
        observed = { target: target.replace(':splat', authored.from_path.slice(source.length - 1)), status: Number(status) }; break;
      }
    }
    expect(observed, authored.from_path).toEqual({ target: authored.to_path, status: authored.status_code });
  }
});

it('restores omitted authored mappings before a later domain-only publication changes the prefix target', () => {
  const exact = rule('/media/photo.jpg', 'https://images.example.com/photo.jpg');
  const frozen = freezeMediaRedirects([prefix, exact]);
  expect(frozen).toEqual({ redirects: [prefix], omitted: [exact] });
  const restored = authoredMediaContent({ redirects: frozen.redirects, media_redirect_omissions: frozen.omitted });
  expect(restored.redirects).toEqual([prefix, exact]);
  expect(restored).not.toHaveProperty('media_redirect_omissions');
  const changed = restored.redirects.map((item: Redirect) => item.id === prefix.id ? { ...item, to_path: 'https://new-images.example.com/:splat' } : item);
  // The original fixed destination becomes an exception to the new prefix.
  expect(freezeMediaRedirects(changed)).toEqual({ redirects: changed, omitted: [] });
});

it('does not invent a wildcard from filenames or remove a rule merely because HTML now uses its destination', () => {
  const rules = [rule('/wp-content/uploads/old.jpg', 'https://images.example.com/hash-new.jpg'), rule('/media/private.jpg', 'https://images.example.com/private.jpg')];
  expect(compactCoveredMediaRedirects(rules)).toBe(rules);
});

it('retains file rules when the renderer drops their covering pattern to protect a live page', () => {
  const exact = rule('/media/photo.jpg', 'https://images.example.com/photo.jpg');
  const rules = [prefix, exact];
  expect(compactCoveredMediaRedirects(rules, 'always', ['/media/about/'])).toBe(rules);
  expect(freezeMediaRedirects(rules, 'always', { pages: [{ id: 'about', slug: 'media/about', title: 'About', status: 'published', content_mode: 'html' }] })).toEqual({ redirects: rules, omitted: [] });
});

it('does not use ambiguous pattern sources as proof of provider coverage', () => {
  const rules = [rule('/media//*', 'https://images.example.com/:splat'), rule('/media/photo.jpg', 'https://images.example.com/photo.jpg')];
  expect(compactCoveredMediaRedirects(rules)).toBe(rules);
});

it('retains exact mappings when generated archive routes are not yet known', () => {
  const rules = [prefix, rule('/media/photo.jpg', 'https://images.example.com/photo.jpg')];
  expect(freezeMediaRedirects(rules, 'always', { pageTemplates: [{ blocks: [{ data: { paginate: 12 } }] }] })).toEqual({ redirects: rules, omitted: [] });
});

it('keeps a literal override when a narrower prefix wins over the matching broad prefix', () => {
  const specific = rule('/media/private/*', 'https://archive.example.com/:splat');
  const exact = rule('/media/private/a.jpg', 'https://images.example.com/private/a.jpg');
  expect(compactCoveredMediaRedirects([prefix, specific, exact])).toEqual([prefix, specific, exact]);
  const matching = rule('/media/private/b.jpg', 'https://archive.example.com/b.jpg');
  expect(compactCoveredMediaRedirects([prefix, specific, matching])).toEqual([prefix, specific]);
});

it('considers generated pattern-base aliases before broader patterns', () => {
  const base = rule('/media/photo.jpg/*', 'https://archive.example.com/:splat');
  const exact = rule('/media/photo.jpg', 'https://images.example.com/photo.jpg');
  expect(compactCoveredMediaRedirects([prefix, base, exact])).toEqual([prefix, base, exact]);
});

it('retains query conditions, encoded or ambiguous paths, trailing slashes and duplicate source overrides', () => {
  const rules = [prefix,
    rule('/media/image.jpg?download=1', 'https://images.example.com/image.jpg'),
    rule('/media/a%2Fb.jpg', 'https://images.example.com/a%2Fb.jpg'),
    rule('/media/å.jpg', 'https://images.example.com/å.jpg'),
    rule('/media/a//b.jpg', 'https://images.example.com/a/b.jpg'),
    rule('/media/a/../b.jpg', 'https://images.example.com/b.jpg'),
    rule('/media/photo.jpg/', 'https://images.example.com/photo.jpg'),
    rule('/media/twice.jpg', 'https://images.example.com/twice.jpg'),
    rule('/media/twice.jpg', 'https://other.example.com/twice.jpg')];
  expect(compactCoveredMediaRedirects(rules)).toEqual(rules);
});

it.each(['always', 'never'] as const)('uses actual emitted destinations under the %s slash policy', policy => {
  const pattern = rule('/media/*', '/files/:splat');
  const exact = rule('/media/photo.jpg', '/files/photo.jpg');
  const expanded = expandRedirectsForTrailingSlashPolicy([pattern], policy);
  const expected = expanded.find(item => item.from_path === '/media/*')!.to_path.replace(':splat', 'photo.jpg');
  expect(compactCoveredMediaRedirects([pattern, exact], policy)).toEqual(expected === exact.to_path ? [pattern] : [pattern, exact]);
});

it('preserves named-pattern precedence and keeps non-file page redirects', () => {
  const named = rule('/media/:folder/:file', 'https://images.example.com/:folder/:file');
  const file = rule('/media/folder/photo.jpg', 'https://images.example.com/folder/photo.jpg');
  const page = rule('/media/page', 'https://images.example.com/page');
  expect(compactCoveredMediaRedirects([prefix, named, file, page])).toEqual([prefix, named, page]);
});

it('builds the compact frozen plan as a static artifact accepted by the unmodified Core 0.3.44 supervisor', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'typeroll-media-redirect-compat-'));
  const oldFiles = ['packages/portal/src/lib/builds/direct-upload.mjs', 'packages/portal/src/lib/builds/contract.mjs', 'packages/shared/src/pages-redirect-limits.mjs'];
  let harness: Awaited<ReturnType<typeof publicationBuildHarness>> | undefined;
  try {
    for (const file of oldFiles) {
      const destination = path.join(temp, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, execFileSync('git', ['show', `core-v0.3.44:${file}`], { cwd: root }));
    }
    const { describeStaticOutput } = await import(/* @vite-ignore */ pathToFileURL(path.join(temp, oldFiles[0])).href);
    const rules = Array.from({ length: 2500 }, (_, i) => rule(`/media/photo-${i}.jpg`, `https://images.example.com/photo-${i}.jpg`));
    rules.push(prefix, rule('/media/renamed.jpg', 'https://images.example.com/hash-renamed.jpg'), rule('/media/temporary.jpg', 'https://images.example.com/temporary.jpg', 302));
    const plan = freezeMediaRedirects(rules);
    const frozen = { ...projectStaticPublication({ site: { name: 'Synthetic migration' },
      settings: { site_name: 'Synthetic migration', fonts: { heading: 'system-ui', body: 'system-ui' } },
      pages: [{ id: 'home', slug: '', title: 'Home', status: 'published', content_mode: 'html', html_content: '<h1>Home</h1>' }],
      partials: [], forms: [], extensions: [], contentTypes: [], blockTypes: [], pageTemplates: [], menus: [], snippets: [], media: [],
      redirects: plan.redirects,
    }, { siteUrl: 'https://site.example.com', coreCommit: 'a'.repeat(40), publishedAt: '2026-11-23T00:00:00Z' }), media_redirect_omissions: plan.omitted };
    harness = await publicationBuildHarness(frozen);
    await harness.run();
    const output = await describeStaticOutput(path.join(harness.destination, 'dist'));
    const text = Buffer.from(output.controls._redirects, 'base64').toString('utf8');
    expect(text).toContain('/media/* https://images.example.com/:splat 301');
    expect(text).toContain('/media/renamed.jpg https://images.example.com/hash-renamed.jpg 301');
    expect(text).toContain('/media/temporary.jpg https://images.example.com/temporary.jpg 302');
    expect(text).not.toContain('/media/photo-');
    expect(text).not.toContain('typeroll-bulk-redirect');
    expect(Object.keys(output.files).some(file => file === '_worker.js' || file.startsWith('functions/'))).toBe(false);
  } finally { await harness?.cleanup(); await fs.rm(temp, { recursive: true, force: true }); }
}, 90_000);
