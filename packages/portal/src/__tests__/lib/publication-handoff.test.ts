import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { mapPublicationParts } from '../../lib/publishing/parallel';
import { readSnapshot, saveSnapshot } from '../../lib/publishing/publication-snapshot';
import { replaceReferences, resolvePublicationReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });
afterEach(() => vi.restoreAllMocks());

it('resolves overlapping exact URLs once, preserves suffixes and external canonicals', () => {
  const replacements: [string, string][] = [['https://old/a.jpg', 'https://new/a.jpg'], ['https://old/a.jpg.large', 'https://new/large.jpg'], ['https://new/a.jpg', 'https://bad/cascade.jpg']];
  expect(replaceReferences({ body: 'https://old/a.jpg?q=1#x https://old/a.jpg.large https://old/a.jpg2', canonical_url: 'https://old/a.jpg' }, replacements)).toEqual({ body: 'https://new/a.jpg?q=1#x https://new/large.jpg https://old/a.jpg2', canonical_url: 'https://old/a.jpg' });
  const manifest = { aliases: ['https://old.example/media/a.jpg'] };
  const frozen = { site_url: 'https://new.example', pages: [{ html: 'https://old.example/about#x https://old.example.evil/a /api/sites/site/media/image/content?w=2', canonical_url: 'https://old.example/about' }], media_manifest: manifest, source_impact_snapshot: { href: 'https://old.example/about' }, reference_mapping: { format: 1, media: [['/api/sites/site/media/image/content', 'https://new.example/media/a.jpg']], website_origins: ['https://old.example'] } };
  const resolved = resolvePublicationReferences(frozen);
  expect(resolved.pages[0]).toEqual({ html: 'https://new.example/about#x https://old.example.evil/a https://new.example/media/a.jpg?w=2', canonical_url: 'https://new.example/about' });
  expect(resolved.media_manifest).toEqual(manifest);
  expect(resolved.source_impact_snapshot).toEqual(frozen.source_impact_snapshot);
  expect(frozen.pages[0].html).toContain('/api/sites/');
});

it('drains already started writes on failure without starting the rest', async () => {
  const started: number[] = [], finished: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const result = mapPublicationParts([0, 1, 2, 3], async value => {
    started.push(value);
    if (value === 0) throw new Error('synthetic failure');
    await blocked; finished.push(value);
  }, 2);
  let settled = false;
  const checked = expect(result).rejects.toThrow('synthetic failure').then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); expect(started).toEqual([0, 1]);
  release(); await checked;
  expect(finished).toEqual([1]); expect(started).toEqual([0, 1]);
});

it('keeps independent snapshot generations immutable and verifies them on resume', async () => {
  const args = { orgId: 'org', siteId: 'site', jobId: 'job' };
  const first = { pages: [{ text: 'a'.repeat(370000) }] }, later = { pages: [{ text: 'new edit' }] };
  const original = await saveSnapshot(args, first), other = await saveSnapshot(args, later);
  expect(original.snapshot_chunks).toBe(4);
  expect(await saveSnapshot(args, first)).toEqual(original);
  expect(await readSnapshot(args, original)).toEqual(first);
  expect(await readSnapshot(args, other)).toEqual(later);
  const chunk = `${paths.deploy('org', 'site', 'job')}/snapshot_versions/${original.snapshot_digest}/chunks/0000`;
  await getStore().updateDoc(chunk, { data: 'tampered' });
  await expect(readSnapshot(args, original)).rejects.toThrow('integrity');
  await expect(saveSnapshot(args, first)).rejects.toMatchObject({ code: 'publication_snapshot_conflict' });
});

it('captures a consistent content view while another request edits and deletes records', async () => {
  const store = getStore(), root = `${paths.site('org', 'site')}/versions`;
  const page = paths.page('org', 'site', 'home'), settings = paths.settings('org', 'site');
  await store.setDoc(page, { title: 'Before' }); await store.setDoc(settings, { site_name: 'Before' });
  await store.readSnapshot!(root, async () => {
    expect(await getStore().getDoc(page)).toMatchObject({ title: 'Before' });
    await store.deleteDoc(page); await store.updateDoc(settings, { site_name: 'After' });
    expect(await getStore().getDoc(settings)).toMatchObject({ site_name: 'Before' });
    expect(await getStore().listDocs(paths.pages('org', 'site'))).toEqual([expect.objectContaining({ title: 'Before' })]);
    expect(() => getStore().updateDoc(page, {})).toThrow('Writes are not allowed');
  });
  expect(await store.getDoc(page)).toBeNull();
  expect(await store.getDoc(settings)).toMatchObject({ site_name: 'After' });
});

it('finds exact library references without treating filenames with the same prefix as used media', async () => {
  const { findReferences } = await import('../../../../../scripts/fixtures/static-publication/references.mjs');
  expect([...findReferences('<img src="https://media.test/a.jpg2"> https://media.test/b.jpg?width=2', ['https://media.test/a.jpg', 'https://media.test/b.jpg'])]).toEqual(['https://media.test/b.jpg']);
});
