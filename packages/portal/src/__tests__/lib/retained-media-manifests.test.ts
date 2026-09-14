import { expect, it } from 'vitest';
import { retainDistinctMediaManifests } from '../../lib/publishing/media-manifest';

const file = (id: number) => ({ id: String(id), source_key: `private/media/originals/${id}`, sha256: String(id).padStart(64, '0'),
  public_key: `media/${id}.png`, public_path: `/media/${id}.png`, aliases: [{ url: `https://media.example.test/${id}.png`, key: `media/${id}.png` }] });
const manifest = (entries = [file(1)]) => ({ account_id: 'account', original_bucket: 'private', public_bucket: 'public', site_prefix: 'media',
  delivery: 'static', media_host: 'site.example.test', website_host: 'site.example.test', media_path_prefix: '/media', entries });

it('does not double a thousand unchanged files when republishing or editing captions', () => {
  const previous = manifest(Array.from({ length: 1000 }, (_, index) => file(index)));
  const current = { ...previous, entries: previous.entries.map(entry => ({ ...entry, caption: 'Edited caption' })) };
  expect(retainDistinctMediaManifests([previous], current)).toEqual([]);
  expect(previous.entries).toHaveLength(1000);
});
it('retains removed files and former public paths, sources, checksums and hosts', () => {
  const old = manifest([file(1), file(2)]);
  expect(retainDistinctMediaManifests([old], manifest())).toEqual([{ ...old, entries: [file(2)] }]);
  for (const patch of [{ public_path: '/legacy/1.png' }, { public_key: 'media/legacy.png' }, { source_key: 'private/media/originals/other' }, { sha256: 'f'.repeat(64) }]) {
    const previous = manifest([{ ...file(1), ...patch }]);
    expect(retainDistinctMediaManifests([previous], manifest())).toEqual([previous]);
  }
  for (const field of ['account_id', 'original_bucket', 'public_bucket', 'site_prefix', 'media_host', 'website_host', 'delivery', 'media_path_prefix']) {
    const previous = { ...manifest(), [field]: 'other' };
    expect(retainDistinctMediaManifests([previous], manifest())).toEqual([previous]);
  }
});
it('preserves older aliases and removes only routes already covered across retained snapshots', () => {
  const previous = manifest([{ ...file(1), aliases: [...file(1).aliases, { url: 'https://old.example.test/image.png', key: 'media/old.png' }] }, file(2)]);
  const result = retainDistinctMediaManifests([previous, structuredClone(previous)], manifest());
  expect(result).toEqual([previous]);
  expect(retainDistinctMediaManifests([manifest()], previous)).toEqual([]);
  expect(retainDistinctMediaManifests([previous], null)).toEqual([previous]);
});
