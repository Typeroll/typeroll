import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paths, type Media } from '@typeroll/shared';
import { getStore, setRuntimeStore } from '../../lib/datastore';
import { SqlDocumentEngine } from '../../lib/store/sql-engine';
import { localTransport } from '../../lib/store/sql-store';
import { nodeSqliteDriver } from '../../lib/store/node-sqlite';
import { ShardedStore } from '../../lib/store/sharded-store';
import { applyMediaReplacements, replaceMedia } from '../../lib/media/replacement';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
const path = (id: string) => `${paths.media('o', 's')}/${id}`;
const media = (id: string) => ({ id, filename: `${id}.jpg`, cdn_url: `https://media.example.test/${id}.jpg`, sha256: id.repeat(64).slice(0, 64), storage: { state: 'ready', key: id } } as Media);
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); for (const id of ['a', 'b', 'c']) await getStore().setDoc(path(id), media(id)); });
afterEach(() => { setRuntimeStore(null); vi.restoreAllMocks(); });

it('atomically rejects competing replacements that would form a cycle in the Cloud store', async () => {
  const engines = new Map<string, SqlDocumentEngine>();
  const store = new ShardedStore({ transport: name => {
    if (!engines.has(name)) engines.set(name, new SqlDocumentEngine(nodeSqliteDriver()));
    return localTransport(engines.get(name)!);
  } }, () => 'unused-id');
  setRuntimeStore(() => store);
  for (const id of ['a', 'b']) await store.setDoc(path(id), media(id));
  const commit = store.compareAndReplaceDoc.bind(store);
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  let arrivals = 0;
  vi.spyOn(store, 'compareAndReplaceDoc').mockImplementation(async (...args) => {
    if (++arrivals === 2) release();
    await bothRead;
    return commit(...args);
  });
  const results = await Promise.allSettled([
    replaceMedia('o', 's', 'a', 'b', false), replaceMedia('o', 's', 'b', 'a', false),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'media_replacement_conflict' } });
});

it('protects the replacement target from deletion', async () => {
  await replaceMedia('o', 's', 'a', 'b', false);
  const { deleteMediaItem } = await import('../../lib/media-deletion');
  await expect(deleteMediaItem('o', 's', 'b')).rejects.toMatchObject({ code: 'media_replacement_in_use' });
  expect(await getStore().getDoc(path('b'))).not.toBeNull();
});

it('previews then records one library replacement without writing any Pages', async () => {
  const store = getStore();
  const pagePath = paths.page('o', 's', 'p', 'main');
  const page = { title: 'Untouched', fields: { image: media('a').cdn_url, alt: 'Editorial context' }, blocks: [] };
  await store.setDoc(pagePath, page);
  expect(await replaceMedia('o', 's', 'a', 'b')).toMatchObject({ dry_run: true, pages_written: 0 });
  expect((await store.getDoc<Media>(path('a')))?.replacement_media_id).toBeUndefined();
  await replaceMedia('o', 's', 'a', 'b', false);
  const result = applyMediaReplacements(page, await store.listDocs<Media>(paths.media('o', 's')));
  expect(result.fields).toEqual({ image: media('b').cdn_url, alt: 'Editorial context' });
  expect(await store.getDoc(pagePath)).toEqual({ id: 'p', ...page });
  await replaceMedia('o', 's', 'a', null, false);
  expect(applyMediaReplacements(page, await store.listDocs<Media>(paths.media('o', 's')))).toEqual(page);
});

it('resolves chains and exact aliases in blocks, fields, templates and HTML without replacing URL prefixes', async () => {
  await getStore().updateDoc(path('a'), { source_aliases: ['https://old.example.test/photo.jpg'], published_url: 'https://site.example.test/media/photo.jpg' });
  await replaceMedia('o', 's', 'a', 'b', false); await replaceMedia('o', 's', 'b', 'c', false);
  const content = { blocks: [{ data: { src: media('a').cdn_url } }], fields: { image: media('b').cdn_url }, templates: [{ html: '<img src="https://old.example.test/photo.jpg">' }], html: '<img src="https://site.example.test/media/photo.jpg">', unrelated: `${media('a').cdn_url}.other` };
  const changed = applyMediaReplacements(content, await getStore().listDocs<Media>(paths.media('o', 's')));
  expect(changed.blocks[0].data.src).toBe(media('c').cdn_url);
  expect(changed.fields.image).toBe(media('c').cdn_url);
  expect(changed.templates[0].html).toContain(media('c').cdn_url);
  expect(changed.html).toContain(media('c').cdn_url);
  expect(changed.unrelated).toBe(content.unrelated);
  await expect(replaceMedia('o', 's', 'c', 'a', false)).rejects.toMatchObject({ code: 'media_replacement_cycle' });
  await expect(replaceMedia('o', 's', 'a', 'a', false)).rejects.toMatchObject({ code: 'media_replacement_cycle' });
});

it('rejects absent, cross-site and unfinished targets', async () => {
  await expect(replaceMedia('o', 's', '../foreign', 'b', false)).rejects.toMatchObject({ code: 'invalid_media_id' });
  await expect(replaceMedia('o', 's', 'a', '..', false)).rejects.toMatchObject({ code: 'invalid_media_id' });
  await getStore().setDoc(`${paths.media('o', 'other')}/foreign`, media('foreign'));
  await expect(replaceMedia('o', 's', 'a', 'foreign', false)).rejects.toMatchObject({ code: 'media_not_found' });
  await getStore().updateDoc(path('b'), { storage: { state: 'uploading' } });
  await expect(replaceMedia('o', 's', 'a', 'b', false)).rejects.toMatchObject({ code: 'media_replacement_not_ready' });
});

it('exposes dry run and apply through the authenticated public route and previews the new image', async () => {
  const store = getStore();
  await store.setDoc(paths.site('o', 's'), { name: 'Synthetic site', created_at: '2026-01-01T00:00:00Z' });
  await store.setDoc(paths.version('o', 's', 'main'), { name: 'Main', kind: 'main', robots_blocked: false });
  await store.setDoc(paths.page('o', 's', 'p', 'main'), { title: 'Example', slug: 'example', status: 'published', content_mode: 'html', html_content: `<img src="${media('a').cdn_url}" alt="Context">` });
  const { createApiKey } = await import('../../lib/api-keys');
  const { token } = await createApiKey({ orgId: 'o', siteId: 's', name: 'Synthetic', createdBy: 'test' });
  const { POST } = await import('../../pages/api/v1/sites/[siteId]/media/[mediaId]/replace');
  const call = (body: unknown, credential = token) => POST({ request: new Request('https://portal.example.test/api/v1/sites/s/media/a/replace', { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), params: { siteId: 's', mediaId: 'a' }, locals: {} } as any) as Promise<Response>;
  expect((await call({ replacement_media_id: 'b' }, 'invalid')).status).toBe(401);
  const dry = await call({ replacement_media_id: 'b' });
  expect(dry.status).toBe(200);
  expect(await dry.json()).toMatchObject({ dry_run: true, pages_written: 0 });
  expect((await call({ replacement_media_id: 'b', typo: true })).status).toBe(400);
  expect((await call({ replacement_media_id: 'b', dry_run: false })).status).toBe(200);
  const { renderPreview } = await import('../../lib/render-preview');
  const html = await renderPreview('o', 's', 'p', 'main', { sharedMediaToken: 'synthetic' });
  expect(html).toContain(media('b').cdn_url);
  expect(html).not.toContain(media('a').cdn_url);
  expect(html).toContain('alt="Context"');
});
