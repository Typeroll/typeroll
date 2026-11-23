import { beforeEach, expect, it, vi } from 'vitest';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { allocatePublicMediaPaths, mediaPathClaims, preferredPublicMediaPath, wordpressMediaPath } from '../../lib/media/public-path';
const root = paths.media('org', 'site');
const file = (id: string, hash = 'a', patch: Partial<Media> & { source_url?: string } = {}): Media & { source_url?: string } => ({
 id, filename: 'photo.jpg', mime_type: 'image/jpeg', sha256: hash.repeat(64), created_at: '2026-11-23T10:00:00Z',
 cdn_url: `https://cms.example.test/api/sites/site/media/${id}/content`, ...patch,
});
const seed = async (...files: Media[]) => { for (const { id, ...doc } of files) await getStore().setDoc(`${root}/${id}`, doc); return getStore().listDocs<Media>(root); };
const allocate = async (files: Media[], dryRun = false) => allocatePublicMediaPaths('org', 'site', files, await getStore().listDocs<Media>(root), { dryRun });
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('uses the root for ordinary uploads and preserves explicitly supplied folders', () => {
 expect(preferredPublicMediaPath(file('one'))).toBe('/photo.jpg');
 expect(preferredPublicMediaPath(file('two', 'b', { filename: 'products/blue/photo.jpg' }))).toBe('/products/blue/photo.jpg');
 expect(preferredPublicMediaPath(file('three', 'c', { public_path: '/chosen/catalogue.jpg' }))).toBe('/chosen/catalogue.jpg');
});
it.each([
 ['https://old.example.test/wp-content/uploads/2024/05/photo.jpg', '/wp-content/uploads', '/2024/05/photo.jpg'],
 ['https://old.example.test/blog/wp-content/uploads/sites/11/2023/04/photo.jpg', '/blog/wp-content/uploads/sites/11', '/2023/04/photo.jpg'],
 ['https://old.example.test/wp-content/uploads/H%C3%B6stl%C3%B6v.jpg', '/wp-content/uploads', '/Höstlöv.jpg'],
])('keeps the upload-relative folders of %s', (source_url, prefix, path) => {
 expect(wordpressMediaPath(source_url)).toMatchObject({ prefix, path });
 expect(preferredPublicMediaPath(file('one', 'a', { source_url }))).toBe(path);
});
it.each(['https://source.example.test/photo.jpg', 'https://source.example.test/wp-content/uploads/a%2Fb.jpg', 'https://user:password@old.example.test/wp-content/uploads/a.jpg', 'not a URL'])('does not infer a WP namespace from %s', source => {
 expect(wordpressMediaPath(source)).toBeNull();
});
it('allocates permanent numeric names in one folder without changing another month', async () => {
 const files = await seed(file('a', 'a', { filename: '2024/05/photo.jpg' }), file('b', 'b', { filename: '2024/05/photo.jpg' }), file('c', 'c', { filename: '2024/06/photo.jpg' }));
 const first = await allocate(files);
 expect([...first.values()].map(m => m.public_path)).toEqual(['/2024/05/photo.jpg', '/2024/05/photo-2.jpg', '/2024/06/photo.jpg']);
 const records = await getStore().listDocs<Media>(root);
 const writes = vi.spyOn(getStore(), 'compareAndReplaceDoc');
 const second = await allocate(records.reverse());
 expect(Object.fromEntries([...second].map(([id, m]) => [id, m.public_path]))).toEqual({ a: '/2024/05/photo.jpg', b: '/2024/05/photo-2.jpg', c: '/2024/06/photo.jpg' });
 expect(writes).not.toHaveBeenCalled(); writes.mockRestore();
});
it('reserves the root name for identical bytes and numbers different file versions', async () => {
 const files = await seed(file('a'), file('b'), file('c', 'b'));
 const named = await allocate(files);
 expect(named.get('a')?.public_path).toBe('/photo.jpg');
 expect(named.get('b')?.public_path).toBe('/photo.jpg');
 expect(named.get('c')?.public_path).toBe('/photo-2.jpg');
});
it('never reuses a deleted name for different bytes or renumbers a surviving file', async () => {
 let files = await seed(file('a'), file('b', 'b'));
 await allocate(files);
 await getStore().deleteDoc(`${root}/a`);
 files = await seed(file('c', 'c'));
 const named = await allocate(files);
 expect(named.get('b')?.public_path).toBe('/photo-2.jpg');
 expect(named.get('c')?.public_path).toBe('/photo-3.jpg');
});
it('keeps a pinned public address after editing its display filename', async () => {
 await allocate(await seed(file('a')));
 await getStore().updateDoc(`${root}/a`, { filename: 'display-only.jpg' });
 expect((await allocate(await getStore().listDocs<Media>(root))).get('a')?.public_path).toBe('/photo.jpg');
});
it('assigns a new address to changed bytes and records the old byte identity', async () => {
 await allocate(await seed(file('a')));
 await getStore().updateDoc(`${root}/a`, { sha256: 'b'.repeat(64) });
 const named = (await allocate(await getStore().listDocs<Media>(root))).get('a')!;
 expect(named.public_path).toBe('/photo-2.jpg');
 expect(named.public_path_history).toEqual([{ path: '/photo.jpg', sha256: 'a'.repeat(64) }]);
 const claims = await getStore().listDocs<any>(mediaPathClaims('org', 'site'));
 expect(claims).toHaveLength(2);
 expect(claims.map(c => c.sha256).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
});
it('keeps dry runs read-only while predicting collisions with the whole library', async () => {
 const files = await seed(file('a', 'a', { public_path: '/photo.jpg' }), file('b', 'b'));
 const before = await getStore().listDocs<Media>(root);
 expect((await allocate(files, true)).get('b')?.public_path).toBe('/photo-2.jpg');
 expect(await getStore().listDocs(root)).toEqual(before);
 expect(await getStore().listDocs(mediaPathClaims('org', 'site'))).toEqual([]);
});
it('protects old explicitly published paths retained in deletion tombstones', async () => {
 await getStore().setDoc(`${paths.site('org', 'site')}/media_removals/deleted`, { identity: file('old', 'b', { public_path: '/photo.jpg' }) });
 expect((await allocate(await seed(file('new')))).get('new')?.public_path).toBe('/photo-2.jpg');
});
it('resolves concurrent assignments in the datastore transaction, not a process lock', async () => {
 const files = await seed(file('a'), file('b', 'b'));
 const [a, b] = await Promise.all(files.map(media => allocatePublicMediaPaths('org', 'site', [media], files)));
 expect(new Set([a.get('a')?.public_path, b.get('b')?.public_path])).toEqual(new Set(['/photo.jpg', '/photo-2.jpg']));
 const claims = await getStore().listDocs<any>(mediaPathClaims('org', 'site'));
 expect(claims).toHaveLength(2);
});
it('does not overwrite a concurrent media rename to obtain a claim', async () => {
 const files = await seed(file('a'));
 await getStore().updateDoc(`${root}/a`, { filename: 'changed.jpg' });
 await expect(allocate(files)).rejects.toMatchObject({ code: 'media_revision_conflict' });
 expect(await getStore().listDocs(mediaPathClaims('org', 'site'))).toHaveLength(0);
});
it('treats encoded and Unicode spellings as the same filename', async () => {
 const files = await seed(file('a', 'a', { public_path: '/Höstlöv.jpg' }), file('b', 'b', { public_path: '/H%C3%B6stl%C3%B6v.jpg' }));
 const named = await allocate(files);
 expect(named.get('a')?.public_path).toBe('/Höstlöv.jpg');
 expect(named.get('b')?.public_path).toBe('/Höstlöv-2.jpg');
});

it('returns to the root filename when an owner clears a custom path', async () => {
 await allocate(await seed(file('a', 'a', { public_path: '/custom/photo.jpg' })));
 await getStore().updateDoc(`${root}/a`, { public_path: null });
 const named = (await allocate(await getStore().listDocs<Media>(root))).get('a')!;
 expect(named.public_path).toBe('/photo.jpg');
 expect(named.public_path_history).toEqual([{ path: '/custom/photo.jpg', sha256: 'a'.repeat(64) }]);
});
it('reserves previously public hash filenames against unrelated uploads', async () => {
 const oldName = `${'a'.repeat(16)}-photo.jpg`;
 const files = await seed(file('a', 'a', { source_aliases: [`https://media.example.test/${oldName}`] }), file('b', 'b', { filename: oldName }));
 expect((await allocate(files)).get('b')?.public_path).toBe(`/${'a'.repeat(16)}-photo-2.jpg`);
});

it('allows an owner to clear an imported month folder and use the root explicitly', async () => {
 await allocate(await seed(file('a', 'a', { source_url: 'https://old.example.test/wp-content/uploads/2024/05/photo.jpg' })));
 await getStore().updateDoc(`${root}/a`, { public_path: null });
 expect((await allocate(await getStore().listDocs<Media>(root))).get('a')?.public_path).toBe('/photo.jpg');
});
