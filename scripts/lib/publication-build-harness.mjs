// Local test/benchmark harness: real frozen renderer, no network or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStaticPublicationProject, sealPublicationProject } from './static-publication.mjs';
import { publicationContentFiles } from '../fixtures/static-publication/content.mjs';
import { digest } from '../../packages/site-template/src/lib/publication-render-cache.mjs';

export async function publicationBuildHarness(publication) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tr-partial-'));
  const destination = path.join(root, 'site');
  await createStaticPublicationProject(publication, destination);
  await fs.symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(destination, 'node_modules'), 'dir');
  await fs.writeFile(path.join(destination, 'package-lock.json'), '{"lockfileVersion":3}');
  return {
    destination,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
    async run(full = false) {
      for (const [name, content] of Object.entries(publicationContentFiles(publication))) {
        await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true });
        await fs.writeFile(path.join(destination, name), content);
      }
      await sealPublicationProject(destination);
      const started = performance.now();
      const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: destination,
        env: { PATH: process.env.PATH, ...(full ? { TYPEROLL_FULL_BUILD: '1' } : {}) }, encoding: 'utf8', timeout: 120000 });
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
