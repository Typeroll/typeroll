vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => false) }));
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));

// The organization collection, offline: a section saved from one site of an
// organization is inserted into another site of the same organization. Its
// image is copied into that site's Media library through the normal private
// media path (R2 is an in-memory fake here), and a style the target site has
// with another definition is created under a new id instead of being mapped.
// A package splits into one entry per template and block type, built-ins are
// listed read-only, files no entry uses are removed, an insert into a page
// lands after a nested block, and an app changes only its own entries.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { MAIN_VERSION_ID, paths, type Media, type SiteSettings, type SiteStyle } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { createBlockTemplate, listBlockTemplates } from '../../lib/block-templates-store';
import { defaultPackageMediaIO } from '../../lib/packages/package-media';
import { exportSitePackage, parseExportMeta, parseExportSelection } from '../../lib/packages/package-export';
import { readWorkingCopy } from '../../lib/working-copy';
import {
  addPackageToCollection, deleteCollectionEntry, insertFromCollection, listCollection, readCollectionEntry,
  saveToCollection, updateCollectionEntry, parseInsertTarget,
} from '../../lib/collections/collections';
import { collectionFilePaths } from '../../lib/collections/collection-files';
import { extensionScopeForApiRequest } from '../../lib/api-auth';

const ORG = 'agency', SRC = 'studio', DST = 'bakery';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const photo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5, 4, 3, 2]);
const objects = new Map<string, Uint8Array>();
const hero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 800 } };
const otherHero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 300 } };
const ctx = (siteId: string) => ({ orgId: ORG, siteId, versionId: MAIN_VERSION_ID });
const actor = { label: 'builder@example.com' };
const later = () => new Date(Date.now() + 60 * 60 * 1000);

function fakeR2() {
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    const input = (command as { input: Record<string, unknown> }).input;
    const id = `${input.Bucket}/${input.Key}`;
    if (command instanceof PutObjectCommand) { objects.set(id, new Uint8Array(input.Body as Uint8Array)); return { ETag: '"put"' }; }
    if (command instanceof CopyObjectCommand) { objects.set(id, objects.get(String(input.CopySource))!); return {}; }
    if (command instanceof DeleteObjectCommand) { objects.delete(id); return {}; }
    if (command instanceof GetObjectCommand) {
      const bytes = objects.get(id);
      if (!bytes) throw new Error(`no object ${id}`);
      return { Body: { transformToByteArray: async () => bytes }, ContentLength: bytes.byteLength, ETag: `"${sha(bytes).slice(0, 8)}"` };
    }
    throw new Error(`unexpected ${(command as object).constructor.name}`);
  });
}

async function sites() {
  const store = getStore();
  await store.setDoc(paths.site(ORG, SRC), { name: 'Studio', created_at: '', media_id: 'studiomed1' });
  await store.setDoc(paths.settings(ORG, SRC, MAIN_VERSION_ID), { site_name: 'Studio', language: 'en', styles: [hero] } as unknown as Record<string, unknown>);
  await store.setDoc(paths.site(ORG, DST), { name: 'Bakery', created_at: '', media_id: 'bakerymed1' });
  await store.setDoc(paths.settings(ORG, DST, MAIN_VERSION_ID), { site_name: 'Bakery', styles: [otherHero] } as unknown as Record<string, unknown>);
  const stored = await defaultPackageMediaIO.store(ORG, SRC, {
    bytes: photo, sha256: sha(photo), filename: 'loaf.png', contentType: 'image/png', altText: 'A loaf',
    source: { package_id: 'none', package_version: '0', media_id: 'none' }, actor: 'builder@example.com',
  });
  await vstore.writeBlockType(ORG, SRC, MAIN_VERSION_ID, 'acme-card', {
    id: 'acme-card', name: 'acme-card', label: 'Card', category: 'custom', container: false, origin: 'user', created_at: '2026-01-01T00:00:00Z',
    schema: [{ name: 'title', type: 'text', label: 'Title' }], template: '<div class="card"><h3>{{title}}</h3></div>',
  });
  await createBlockTemplate({ orgId: ORG, siteId: SRC }, {
    id: 'hero', name: 'Hero', kind: 'section', category: 'Heroes', preview: stored.cdn_url,
    blocks: [
      { id: 'h', type: 'core/rich_heading', data: { html: 'Fresh bread', level: 'h2', style_id: 'hero' } },
      { id: 'p', type: 'core/prose', data: { html: `<p><img src="${stored.cdn_url}" alt="A loaf"></p>` } },
      { id: 'k', type: 'acme-card', data: { title: 'Menu' } },
    ],
  });
  // The target page has a nested block to insert after.
  await store.setDoc(paths.page(ORG, DST, 'home', MAIN_VERSION_ID), {
    title: 'Home', slug: '', content_type: 'page', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'cols', type: 'core/columns', data: {}, slots: [[{ id: 'left', type: 'core/prose', data: { html: '<p>Left</p>' } }], []] }],
  });
  return stored;
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  objects.clear();
  vi.stubEnv('PORTAL_PUBLIC_URL', 'https://cms.example.com');
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('R2_BUCKET', 'legacy-public');
  vi.stubEnv('R2_PRIVATE_BUCKET', 'private-drafts');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-draft-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-draft-secret');
  vi.stubEnv('PREVIEW_HMAC_SECRET', 'synthetic-preview-secret-for-tests-only-0123456789');
  fakeR2();
});

describe('organization collection', () => {
  it('saves a section from one site and inserts it into another site of the organization, creating its styles and copying its media', async () => {
    await sites();
    const { entry } = await saveToCollection(ctx(SRC), { kind: 'block_template', id: 'hero', category: 'Heroes' }, actor);
    // The template's own kind decides: a section.
    expect(entry).toMatchObject({ kind: 'section', name: 'Hero', category: 'Heroes', source: { type: 'site', site_id: SRC }, created_by: 'builder@example.com' });
    expect(entry.package.kind).toBe('collection');
    expect(entry.package.contents.styles?.map(style => style.id)).toEqual(['hero']);
    expect(entry.package.contents.block_types?.map(type => type.id)).toEqual(['acme-card']);
    expect(entry.package.media).toHaveLength(1);
    expect(entry.preview).toBe(entry.package.media[0]!.id);
    // The file is stored once for the organization, by sha256.
    expect(await getStore().getDoc(collectionFilePaths.file(ORG, sha(photo)))).toMatchObject({ sha256: sha(photo), content_type: 'image/png' });

    const listed = await listCollection(ORG, { previewBase: '/api/sites/bakery/collection' });
    const own = listed.find(item => item.id === entry.id)!;
    expect(own).toMatchObject({ kind: 'section', summary: { block_count: 3, top_level_types: ['core/rich_heading', 'core/prose', 'acme-card'], styles: 1, block_types: 1, media: 1 } });
    expect(own.preview_url).toBe(`/api/sites/bakery/collection/${entry.id}/media/${entry.preview}`);
    expect(own).not.toHaveProperty('package');

    const { report } = await insertFromCollection({ ...ctx(DST), permission: 'write', design: true, actor: 'builder@example.com' }, entry, { target: 'library' });
    // Never mapped to the site's "hero": created under a new id, and the content rewritten.
    expect(report.renamed).toContainEqual({ section: 'styles', from: 'hero', to: 'hero-2' });
    const settings = (await vstore.settings(ORG, DST, MAIN_VERSION_ID)) as SiteSettings;
    expect(settings.styles!.map(style => style.id)).toEqual(['hero', 'hero-2']);
    expect(settings.styles!.find(style => style.id === 'hero')!.base).toEqual({ weight: 300 });
    const template = (await listBlockTemplates({ orgId: ORG, siteId: DST })).find(item => item.name === 'Hero')!;
    expect(template.blocks[0]!.data.style_id).toBe('hero-2');
    expect(await vstore.blockType(ORG, DST, MAIN_VERSION_ID, 'acme-card')).toBeTruthy();
    // The image is now the target site's own file.
    const library = await getStore().listDocs<Media>(paths.media(ORG, DST));
    expect(library).toHaveLength(1);
    expect(JSON.stringify(template.blocks)).toContain(library[0]!.cdn_url);
    expect(JSON.stringify(template.blocks)).not.toContain('typeroll-media:');
  });

  it('inserts the blocks into a page draft after a nested block, without adding a template', async () => {
    await sites();
    const { entry } = await saveToCollection(ctx(SRC), { kind: 'section', id: 'hero', name: 'Bakery hero' }, actor);
    const target = parseInsertTarget({ target: 'page', page_id: 'home', after_block_id: 'left' });
    const result = await insertFromCollection({ ...ctx(DST), permission: 'write', design: true, actor: 'builder@example.com' }, entry, target);
    expect(result.page!.added_ids).toHaveLength(3);
    const draft = await readWorkingCopy(ctx(DST), { kind: 'page', id: 'home' });
    const blocks = draft!.fields!.blocks as Array<{ id: string; slots?: Array<Array<{ id: string; type: string; data: Record<string, unknown> }>> }>;
    // In the column's slot, right after "left".
    expect(blocks[0]!.slots![0]!.map(block => block.id)).toEqual(['left', ...result.page!.added_ids]);
    expect(blocks[0]!.slots![0]![1]!.data.style_id).toBe('hero-2');
    expect(await listBlockTemplates({ orgId: ORG, siteId: DST })).toEqual([]);
    // A missing page is refused before anything is written.
    await expect(insertFromCollection({ ...ctx(DST), permission: 'write', actor: 'x' }, entry, { target: 'page', page_id: 'nope' })).rejects.toMatchObject({ status: 404 });
    expect(() => parseInsertTarget({ target: 'page', page_id: 'home', after_block_id: 'left', position: 1 })).toThrow(/not both/);
  });

  it('splits a package into one entry per template and block type, and keeps a site package whole', async () => {
    await sites();
    const exported = await exportSitePackage(ctx(SRC), parseExportSelection({ kind: 'collection', block_templates: ['hero'], block_types: ['acme-card'] }),
      parseExportMeta({ id: 'acme-pack', name: 'Acme pack', version: '2.0.0', author: 'Acme Studio' }));
    const { entries } = await addPackageToCollection(ORG, exported.zip, actor);
    expect(entries.map(entry => [entry.kind, entry.name])).toEqual([['section', 'Hero'], ['block_type', 'Card']]);
    // The section carries its block type and style; the block type entry only itself.
    expect(entries[0]!.package.contents.block_types?.map(type => type.id)).toEqual(['acme-card']);
    expect(entries[0]!.package.media).toHaveLength(1);
    expect(entries[1]!.package.contents).toEqual({ block_types: [expect.objectContaining({ id: 'acme-card' })] });
    expect(entries[1]!.package.media).toEqual([]);
    expect(entries[0]!.source).toMatchObject({ type: 'package', package_id: 'acme-pack', package_name: 'Acme pack', version: '2.0.0', publisher: 'Acme Studio', verified: false });

    const site = await exportSitePackage(ctx(SRC), parseExportSelection({ kind: 'site' }), parseExportMeta({ id: 'studio-site', name: 'Studio site', version: '1.0.0' }));
    const whole = await addPackageToCollection(ORG, site.zip, actor);
    expect(whole.entries.map(entry => entry.kind)).toEqual(['package']);
    expect(whole.entries[0]!.package.kind).toBe('site');
  });

  it('lists the built-ins read-only and refuses to change or remove them', async () => {
    await sites();
    const listed = await listCollection(ORG, { renderVersion: 15, previewBase: '/x' });
    const builtins = listed.filter(entry => entry.source.type === 'builtin');
    expect(builtins.length).toBeGreaterThan(10);
    expect(builtins.every(entry => entry.read_only === true)).toBe(true);
    expect(builtins.some(entry => entry.kind === 'section')).toBe(true);
    const id = builtins[0]!.id;
    await expect(updateCollectionEntry(ORG, id, { name: 'Mine' }, actor)).rejects.toMatchObject({ status: 403, code: 'collection_entry_read_only' });
    await expect(deleteCollectionEntry(ORG, id, actor)).rejects.toMatchObject({ status: 403, code: 'collection_entry_read_only' });
    // A built-in section inserts like any entry.
    const builtin = (await readCollectionEntry(ORG, builtins.find(entry => entry.kind === 'section')!.id))!;
    const { report } = await insertFromCollection({ ...ctx(DST), permission: 'write', design: true, actor: 'x' }, builtin, { target: 'library' });
    expect(report.created.block_templates).toHaveLength(1);
  });

  it('removes the files no entry uses when an entry is deleted, and keeps shared ones', async () => {
    await sites();
    const first = (await saveToCollection(ctx(SRC), { kind: 'section', id: 'hero', name: 'One' }, actor)).entry;
    const second = (await saveToCollection(ctx(SRC), { kind: 'section', id: 'hero', name: 'Two' }, actor)).entry;
    const file = collectionFilePaths.file(ORG, sha(photo));
    expect((await deleteCollectionEntry(ORG, first.id, actor, { now: later })).files_removed).toBe(0);
    expect(await getStore().getDoc(file)).toBeTruthy();
    expect(await deleteCollectionEntry(ORG, second.id, actor, { now: later })).toMatchObject({ deleted: true, files_removed: 1 });
    expect(await getStore().getDoc(file)).toBeNull();
    expect([...objects.keys()].some(key => key.includes(`collection/${ORG}/`))).toBe(false);
    // Recently stored files survive a deletion at the same moment (an entry may be saving).
    const third = (await saveToCollection(ctx(SRC), { kind: 'section', id: 'hero', name: 'Three' }, actor)).entry;
    const fourth = (await saveToCollection(ctx(SRC), { kind: 'block_type', id: 'acme-card' }, actor)).entry;
    await deleteCollectionEntry(ORG, third.id, actor);
    expect(await getStore().getDoc(file)).toBeTruthy();
    expect(fourth.kind).toBe('block_type');
  });

  it('lets an app add entries and change only its own', async () => {
    await sites();
    const exported = await exportSitePackage(ctx(SRC), parseExportSelection({ kind: 'collection', block_templates: ['hero'] }), parseExportMeta({ id: 'ready', name: 'Ready', version: '1.0.0' }));
    const app = { label: 'extension:inst1', extensionId: 'agency-app' };
    const { entries: [added] } = await addPackageToCollection(ORG, exported.zip, app);
    expect(added!.source).toMatchObject({ type: 'app', extension_id: 'agency-app' });
    expect((await updateCollectionEntry(ORG, added!.id, { description: 'From the app' }, app)).description).toBe('From the app');
    const mine = (await saveToCollection(ctx(SRC), { kind: 'section', id: 'hero' }, actor)).entry;
    await expect(updateCollectionEntry(ORG, mine.id, { name: 'Taken' }, app)).rejects.toMatchObject({ status: 403, code: 'collection_entry_not_owned' });
    await expect(deleteCollectionEntry(ORG, mine.id, { label: 'extension:other', extensionId: 'other-app' })).rejects.toMatchObject({ code: 'collection_entry_not_owned' });
    expect((await deleteCollectionEntry(ORG, added!.id, app)).deleted).toBe(true);
  });

  it('maps the collection routes to the collection scopes, and keeps saving and inserting from apps', () => {
    const at = (rest: string) => `/api/v1/sites/s1/collection${rest}`;
    expect(extensionScopeForApiRequest(at(''), 'GET')).toBe('collection:read');
    expect(extensionScopeForApiRequest(at('/e1'), 'GET')).toBe('collection:read');
    expect(extensionScopeForApiRequest(at('/e1/media/m1'), 'GET')).toBe('collection:read');
    expect(extensionScopeForApiRequest(at('/import'), 'POST')).toBe('collection:write');
    expect(extensionScopeForApiRequest(at('/e1'), 'PATCH')).toBe('collection:write');
    expect(extensionScopeForApiRequest(at('/e1'), 'DELETE')).toBe('collection:write');
    expect(extensionScopeForApiRequest(at('/save'), 'POST')).toBeNull();
    expect(extensionScopeForApiRequest(at('/e1/insert'), 'POST')).toBeNull();
  });
});
