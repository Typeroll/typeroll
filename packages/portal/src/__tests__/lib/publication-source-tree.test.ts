import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { publicationSourceTree } from '../../lib/publishing/source-tree';

let commit: string;
let location: string;
const template = (renderer: string) => JSON.stringify({ format: 'typeroll-publication-template', version: '1', files: {
  'package-lock.json': '{"lockfileVersion":3}', 'scripts/build.mjs': renderer,
} });

beforeEach(async () => {
  const { dir } = makeTmpFixtures();
  await resetDatastore();
  commit = randomBytes(20).toString('hex');
  location = join(dir, 'publication-template.json');
  vi.stubEnv('TYPEROLL_SOURCE_SHA', commit);
  vi.stubEnv('TYPEROLL_PUBLICATION_TEMPLATE', location);
});
afterEach(() => vi.unstubAllEnvs());

it('restores the exact old renderer after a process restart and Core upgrade', async () => {
  await writeFile(location, template('original renderer'));
  const publication = { core_commit: commit, pages: [{ title: 'Published content' }] };
  const first = await publicationSourceTree(publication);
  await writeFile(location, template('replacement renderer'));
  vi.stubEnv('TYPEROLL_SOURCE_SHA', 'b'.repeat(40));
  vi.resetModules();
  const restarted = await import('../../lib/publishing/source-tree');
  const restored = await restarted.publicationSourceTree(publication);
  expect(restored).toEqual(first);
  expect(restored['scripts/build.mjs']).toBe('original renderer');
  const manifest = JSON.parse(restored['publication-manifest.json']);
  expect(manifest.files['scripts/build.mjs']).toBe(createHash('sha256').update('original renderer').digest('hex'));
});

it('does not substitute the current renderer when the old frozen template is missing', async () => {
  await writeFile(location, template('current renderer'));
  await expect(publicationSourceTree({ core_commit: 'c'.repeat(40) })).rejects.toThrow('original publication renderer is unavailable');
});

it('rejects an altered stored renderer before producing a source tree', async () => {
  const original = template('trusted renderer');
  const root = `publishing_templates/${commit}`;
  await getStore().setDoc(root, { count: 1, digest: createHash('sha256').update(original).digest('hex') });
  await getStore().setDoc(`${root}/chunks/0`, { data: template('altered renderer') });
  await expect(publicationSourceTree({ core_commit: commit })).rejects.toThrow('integrity verification');
});
