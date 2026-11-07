// Local test/benchmark harness: real frozen renderer, no network or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createStaticPublicationProject, sealPublicationProject } from './static-publication.mjs';
import { publicationContentFiles } from '../fixtures/static-publication/content.mjs';
import { digest } from '../../packages/site-template/src/lib/publication-render-cache.mjs';

const INTER = fileURLToPath(new URL('../../node_modules/@fontsource-variable/inter/', import.meta.url));

/**
 * Self-hosted theme fonts come from the build's font cache, so builds stay
 * offline. The cache holds real Inter (the default theme font), laid out as
 * the build would copy it from Google Fonts: one variable woff2 per subset,
 * named by content hash. Screenshots then show the type customers see.
 */
async function seedInterFontCache(destination) {
  const fontCss = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  const fonts = path.join(destination, '.publication-fonts', createHash('sha256').update(fontCss).digest('hex').slice(0, 32));
  await fs.mkdir(fonts, { recursive: true });
  const rules = [];
  for (const [, file, range] of (await fs.readFile(path.join(INTER, 'wght.css'), 'utf8'))
    .matchAll(/src: url\(\.\/files\/([\w-]+\.woff2)\)[^;]*;\s*unicode-range: ([^;]+);/g)) {
    const bytes = await fs.readFile(path.join(INTER, 'files', file));
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.woff2`;
    await fs.writeFile(path.join(fonts, name), bytes);
    rules.push(`@font-face{font-family:'Inter';font-style:normal;font-weight:400 700;font-display:swap;src:url(/_typeroll/fonts/${name}) format('woff2');unicode-range:${range}}`);
  }
  assert.ok(rules.length, 'Inter font files not found in @fontsource-variable/inter');
  await fs.writeFile(path.join(fonts, 'fonts.css'), rules.join('\n') + '\n');
}

export async function publicationBuildHarness(publication) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-partial-'));
  const destination = path.join(root, 'site');
  await createStaticPublicationProject(publication, destination);
  await fs.symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  await seedInterFontCache(destination);
  return {
    destination,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
    async run(full = false, environment = {}) {
      for (const [name, content] of Object.entries(publicationContentFiles(publication))) {
        await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true });
        await fs.writeFile(path.join(destination, name), content);
      }
      await sealPublicationProject(destination);
      const started = performance.now();
      const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination,
        env: { PATH: process.env.PATH, ...environment, ...(full ? { TYPEROLL_FULL_BUILD: '1' } : {}) }, encoding: 'utf8', timeout: 120000 });
      const milliseconds = performance.now() - started;
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const report = JSON.parse(await fs.readFile(path.join(destination, '.publication-work/render-report.json'), 'utf8'));
      return { report, milliseconds, stdout: result.stdout };
    },
    async output() {
      const files = {};
      async function walk(dir, prefix = '') {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), prefix + entry.name + '/');
          else files[prefix + entry.name] = digest(await fs.readFile(path.join(dir, entry.name)));
        }
      }
      await walk(path.join(destination, 'dist')); return files;
    },
    async receipts() {
      const directory = path.join(destination, '.publication-work/render-cache');
      const entries = await Promise.all((await fs.readdir(directory)).filter(name => name !== 'input.json')
        .map(async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))));
      return Object.fromEntries(entries.map(entry => [entry.pathname, entry]));
    },
  };
}
