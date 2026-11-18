import { expect, it } from 'vitest';
import { retainDistinctMediaManifests, replacedMediaRedirects } from '../../lib/publishing/media-manifest';

const file = (id: number) => ({ id: String(id), source_key: `private/media/originals/${id}`, sha256: String(id).padStart(64, '0'),
  public_key: `media/${id}.png`, public_path: `/media/${id}.png`, aliases: [{ url: `https://media.example.test/${id}.png`, key: `media/${id}.png` }] });
const manifest = (entries = [file(1)]) => ({ account_id: 'account', original_bucket: 'private', public_bucket: 'public', site_prefix: 'media',
  delivery: 'static', media_host: 'site.example.test', website_host: 'site.example.test', media_path_prefix: '/media', entries });

const unsafe = { ...file(1), public_path: '/media/0dbb87db1719d69c-illustration.svg', mime_type: 'image/svg+xml' };
const safe = { ...unsafe, public_path: '/media/62ee431810372315-illustration.svg', svg_sanitized: true };
it('redirects a sanitized replacement without retaining the old unsafe SVG bytes', () => {
  const previous = manifest([unsafe]), current = manifest([safe]);
  expect(retainDistinctMediaManifests([previous], current)).toEqual([]);
  expect(replacedMediaRedirects([previous], current)).toEqual([expect.objectContaining({
    media_id: '1', from_path: unsafe.public_path, to_path: safe.public_path, status_code: 301,
  })]);
});
it('retains the alias across later publications and retargets it by media identity', () => {
  const redirects = replacedMediaRedirects([manifest([unsafe])], manifest([safe]));
  expect(replacedMediaRedirects([], manifest([safe]), [], redirects)).toEqual(redirects);
  const newer = { ...safe, public_path: '/media/newer-illustration.svg' };
  expect(replacedMediaRedirects([], manifest([newer]), [], redirects)[0].to_path).toBe(newer.public_path);
  expect(replacedMediaRedirects([], manifest([]), [], redirects)).toEqual([]);
  // Existing static retention keeps the safe file available even if this page
  // stops referencing it. Its older alias must not disappear on that publish.
  expect(replacedMediaRedirects([manifest([safe])], null, [], redirects)).toEqual(redirects);
});
it('does not redirect deleted, unrelated or still-unsafe media to an invented replacement', () => {
  for (const entries of [[], [{ ...safe, id: 'other' }], [unsafe]])
    expect(replacedMediaRedirects([manifest([unsafe])], manifest(entries))).toEqual([]);
  expect(replacedMediaRedirects([manifest([unsafe])], { ...manifest([safe]), delivery: 'r2' })).toEqual([]);
});
it('refuses collisions and conflicting authored redirects instead of overriding them', () => {
  expect(() => replacedMediaRedirects([manifest([unsafe])], manifest([safe, { ...safe, id: 'other', public_path: unsafe.public_path }]))).toThrow('conflicts');
  expect(() => replacedMediaRedirects([manifest([unsafe])], manifest([safe]), [{ id: 'custom', from_path: unsafe.public_path, to_path: '/somewhere', status_code: 301 } as any])).toThrow('conflicts');
  for (const path of ['/media/*.svg', '/media/:name.svg', '/media/%2A.svg'])
    expect(() => replacedMediaRedirects([manifest([{ ...unsafe, public_path: path }])], manifest([safe]))).toThrow('pattern characters');
});

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

import { authoredMediaContent, selectRetainedMedia } from '../../lib/publishing/media-manifest';

it('omits deleted historical files before an older engine receives the publication', () => {
  const old = manifest([file(1), file(2)]), current = manifest([file(1)]);
  const source = { pages: [{ body: '/media/1.png' }], media: [file(2)], media_manifest: old,
    retained_media_manifests: [old], source_impact_snapshot: { media: [file(2)] },
    reference_mapping: { media: [['/old.png', '/media/2.png']] } };
  const selected = selectRetainedMedia([old, structuredClone(old)], current, source, ['1']);
  expect(selected.deleted).toBe(1);
  expect(selected.warnings).toEqual([expect.stringContaining('1 deleted')]);
  expect(retainDistinctMediaManifests(selected.manifests, current)).toEqual([]);
  expect(old.entries).toHaveLength(2);
});

it('keeps former addresses of used library media, but does not prepare unused library files', () => {
  const old = manifest([file(1), file(2)]), current = manifest([{ ...file(1), public_path: '/new/1.png' }]);
  const selected = selectRetainedMedia([old], current, { pages: [] }, ['1', '2']);
  expect(selected.manifests[0].entries).toEqual([file(1)]);
  expect(selected.unused).toBe(1);
});

it.each(['pages', 'partials', 'pageTemplates', 'settings', 'styles', 'blockTypes', 'menus', 'derived'])(
  'refuses a deleted media reference in saved %s instead of silently weakening integrity', key => {
    expect(() => selectRetainedMedia([manifest([file(2)])], null,
      { [key]: [{ image: '/media/2.png?width=400' }] }, [])).toThrow('saved content still references deleted media 2');
  });
it('keeps media reached through an authored redirect, not generated redirect history', () => {
  const old = manifest([file(2)]), rule = { id: 'legacy', from_path: '/old.png', to_path: '/media/2.png' };
  expect(selectRetainedMedia([old], null, { redirects: [rule] }, ['2']).manifests).toEqual([old]);
  expect(() => selectRetainedMedia([old], null, { redirects: [rule] }, [])).toThrow('deleted media');
  expect(selectRetainedMedia([old], null, { redirects: [rule], media_replacement_redirects: [rule] }, []).manifests).toEqual([]);
});
it('does not mistake a filename prefix for a reference, and handles an empty library', () => {
  expect(selectRetainedMedia([manifest([file(2)])], null, { pages: [{ body: '/media/2.png-other' }] }, []).deleted).toBe(1);
  expect(selectRetainedMedia([], null, {}, [])).toEqual({ manifests: [], warnings: [], deleted: 0, unused: 0 });
  expect(authoredMediaContent({ pages: [1], retained_media_manifests: [manifest()] })).toEqual({ pages: [1], redirects: [] });
});
