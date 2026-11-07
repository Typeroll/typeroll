vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => false) }));
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));

// Copy and paste of blocks, offline: blocks copied from a page of one site
// are pasted into a page of another site of the same organization. The
// image is copied into the target site's Media library through the normal
// private media path (R2 is an in-memory fake), the style the target has
// with another definition is created as "Hero (imported)" instead of being
// mapped, the block type is created, and the blocks get new ids. A paste by
// someone who cannot read the source site leaves its image out, a paste into
// the same site imports nothing, and the API keys decide what they may read.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { MAIN_VERSION_ID, paths, parseBlockClipboard, type Block, type Media, type SiteSettings, type SiteStyle } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { defaultPackageMediaIO } from '../../lib/packages/package-media';
import { readWorkingCopy } from '../../lib/working-copy';
import { copyBlocks, parseCopyRequest, parsePasteRequest, pasteBlocks, siteKey, type SourceAccess } from '../../lib/packages/clipboard';

const ORG = 'agency', SRC = 'studio', DST = 'bakery', PORTAL = 'https://cms.example.com';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const photo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const objects = new Map<string, Uint8Array>();
const hero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 800 } };
const otherHero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 300 } };
const site = (siteId: string) => ({ orgId: ORG, siteId, versionId: MAIN_VERSION_ID });
const writer = (siteId: string) => ({ ...site(siteId), permission: 'write' as const, actor: 'editor@example.com', portal: PORTAL });
const readsEverything: SourceAccess = async () => ({ orgId: ORG });
const readsNothing: SourceAccess = async () => null;

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
  await store.setDoc(paths.org(ORG), { name: 'Agency', slug: ORG, plan: 'free', created_at: '2026-01-01' });
  await store.setDoc(paths.site(ORG, SRC), { name: 'Studio', created_at: '', media_id: 'studiomed1' });
  await store.setDoc(paths.settings(ORG, SRC, MAIN_VERSION_ID), { site_name: 'Studio', styles: [hero] } as unknown as Record<string, unknown>);
  await store.setDoc(paths.site(ORG, DST), { name: 'Bakery', created_at: '', media_id: 'bakerymed1' });
  await store.setDoc(paths.settings(ORG, DST, MAIN_VERSION_ID), { site_name: 'Bakery', styles: [otherHero] } as unknown as Record<string, unknown>);
  const stored = await defaultPackageMediaIO.store(ORG, SRC, {
    bytes: photo, sha256: sha(photo), filename: 'loaf.png', contentType: 'image/png', altText: 'A loaf',
    source: { package_id: 'none', package_version: '0', media_id: 'none' }, actor: 'editor@example.com',
  });
  await vstore.writeBlockType(ORG, SRC, MAIN_VERSION_ID, 'acme-card', {
    id: 'acme-card', name: 'acme-card', label: 'Card', category: 'custom', container: false, origin: 'user', created_at: '2026-01-01T00:00:00Z',
    schema: [{ name: 'title', type: 'text', label: 'Title' }], template: '<div class="card"><h3>{{title}}</h3></div>',
  });
  await vstore.writePartial(ORG, SRC, MAIN_VERSION_ID, 'promo', {
    name: 'Promo', kind: 'free', status: 'published', content_mode: 'blocks', blocks: [{ id: 'pp', type: 'core/prose', data: { html: '<p>Order now</p>' } }],
  });
  await store.setDoc(paths.page(ORG, SRC, 'about', MAIN_VERSION_ID), { title: 'About', slug: 'about', content_type: 'page', content_mode: 'blocks', status: 'published', blocks: [] });
  await store.setDoc(paths.page(ORG, SRC, 'home', MAIN_VERSION_ID), {
    title: 'Home', slug: '', content_type: 'page', content_mode: 'blocks', status: 'published',
    blocks: [
      { id: 'intro', type: 'core/section', data: {}, children: [
        { id: 'h', type: 'core/rich_heading', data: { html: 'Fresh bread', level: 'h2', style_id: 'hero' } },
        { id: 'p', type: 'core/prose', data: { html: `<p><img src="${stored.cdn_url}" alt="A loaf"></p>` } },
      ] },
      { id: 'k', type: 'acme-card', data: { title: 'Menu' } },
      { id: 'g', type: 'core/global_block', data: { global_block_id: 'promo' } },
      { id: 'b', type: 'core/button', data: { label: 'About us', page_id: 'about' } },
    ],
  });
  await store.setDoc(paths.page(ORG, DST, 'home', MAIN_VERSION_ID), {
    title: 'Home', slug: '', content_type: 'page', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'cols', type: 'core/columns', data: {}, slots: [[{ id: 'left', type: 'core/prose', data: { html: '<p>Left</p>' } }], []] }],
  });
  return stored;
}

async function draftBlocks(siteId: string, pageId = 'home'): Promise<Block[]> {
  return (await readWorkingCopy(site(siteId), { kind: 'page', id: pageId }))!.fields!.blocks as Block[];
}

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  objects.clear();
  vi.stubEnv('PORTAL_PUBLIC_URL', PORTAL);
  vi.stubEnv('R2_ACCOUNT_ID', 'b'.repeat(32));
  vi.stubEnv('R2_BUCKET', 'legacy-public');
  vi.stubEnv('R2_PRIVATE_BUCKET', 'private-drafts');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'synthetic-draft-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'synthetic-draft-secret');
  vi.stubEnv('PREVIEW_HMAC_SECRET', 'synthetic-preview-secret-for-tests-only-0123456789');
  fakeR2();
});

describe('block clipboard', () => {
  it('copies blocks with the styles, block types and global blocks they use, and media by address', async () => {
    const stored = await sites();
    const copied = await copyBlocks({ ...site(SRC), portal: PORTAL }, parseCopyRequest({ page_id: 'home', block_ids: ['k', 'intro', 'h', 'g', 'b'] }));
    const { clipboard } = copied;
    // Page order; the heading comes inside its section, not twice.
    expect(clipboard.package.contents.blocks!.map(block => block.id)).toEqual(['intro', 'k', 'g', 'b']);
    expect(clipboard.source).toEqual({ portal: PORTAL, site_id: SRC, site_key: siteKey(ORG, SRC), page_id: 'home' });
    expect(clipboard.package.kind).toBe('clipboard');
    expect(clipboard.package.contents.styles!.map(style => style.id)).toEqual(['hero']);
    expect(clipboard.package.contents.block_types!.map(type => type.id)).toEqual(['acme-card']);
    expect(clipboard.package.contents.global_blocks!.map(global => global.id)).toEqual(['promo']);
    expect(clipboard.package.media).toEqual([]);
    expect(clipboard.media).toEqual([{ site_id: SRC, media_id: stored.id, addresses: [stored.cdn_url], filename: 'loaf.png' }]);
    expect(clipboard.page_links).toEqual({ about: '/about' });
    expect(clipboard.text).toBe('Fresh bread\nMenu\nAbout us');
    expect(copied.count).toEqual({ top: 4, total: 6 });
    // The text is what goes on the system clipboard, and parses back.
    expect(parseBlockClipboard(copied.clipboard_text)).toEqual(clipboard);
    expect(copied.clipboard_html).toContain('<p>Fresh bread</p>');
    await expect(copyBlocks({ ...site(SRC), portal: PORTAL }, { page_id: 'home', block_ids: ['nope'] })).rejects.toMatchObject({ status: 404, code: 'block_not_found' });
  });

  it('pastes into another site: copies the media, creates the style as imported, the block type and global block, with new ids', async () => {
    await sites();
    const { clipboard_text } = await copyBlocks({ ...site(SRC), portal: PORTAL }, { page_id: 'home', block_ids: ['intro', 'k', 'g', 'b'] });
    const result = await pasteBlocks(writer(DST), parsePasteRequest({ clipboard: clipboard_text, page_id: 'home', after_block_id: 'left' }), { sourceAccess: readsEverything });
    expect(result.mode).toBe('other_site');
    expect(result.media).toMatchObject({ copied: 1, left_out: 0 });
    expect(result.message).toBe('Pasted 4 blocks; created the style Hero (imported); created the block type acme-card; created 1 global block; copied 1 media file');
    // Styles are never mapped: the site's own "hero" stays and the pasted heading uses the imported copy.
    const styles = ((await vstore.settings(ORG, DST, MAIN_VERSION_ID)) as SiteSettings).styles!;
    expect(styles.map(style => [style.id, style.name])).toEqual([['hero', 'Hero'], ['hero-2', 'Hero (imported)']]);
    expect(styles[0]!.base).toEqual({ weight: 300 });
    expect(await vstore.blockType(ORG, DST, MAIN_VERSION_ID, 'acme-card')).toBeTruthy();
    expect((await vstore.partial(ORG, DST, MAIN_VERSION_ID, 'promo'))?.name).toBe('Promo');
    // Nested position: in the column's slot, right after "left".
    const blocks = await draftBlocks(DST);
    const slot = blocks[0]!.slots![0]!;
    expect(slot.map(block => block.id)).toEqual(['left', ...result.page.added_ids]);
    expect(result.page.added_ids.some(id => ['intro', 'k', 'g', 'b'].includes(id))).toBe(false);
    expect(slot[1]!.children![0]!.data.style_id).toBe('hero-2');
    expect(slot[1]!.children![0]!.id).not.toBe('h');
    // The image is now the target site's own file.
    const library = await getStore().listDocs<Media>(paths.media(ORG, DST));
    expect(library).toHaveLength(1);
    expect(library[0]!.sha256).toBe(sha(photo));
    expect(slot[1]!.children![1]!.data.html).toContain(library[0]!.cdn_url);
    expect(JSON.stringify(slot)).not.toContain(`/api/sites/${SRC}/`);
    // A link to the source site's page is kept as its address.
    expect(slot[4]!.data).toEqual({ label: 'About us', url: '/about' });
    expect(result.report.warnings.some(warning => warning.includes('plain addresses'))).toBe(true);

    // Pasting again reuses the identical style and the file with the same bytes.
    const again = await pasteBlocks(writer(DST), parsePasteRequest({ clipboard: clipboard_text, page_id: 'home' }), { sourceAccess: readsEverything });
    expect(again.media).toMatchObject({ copied: 0, reused: 1 });
    expect(((await vstore.settings(ORG, DST, MAIN_VERSION_ID)) as SiteSettings).styles!.map(style => style.id)).toEqual(['hero', 'hero-2']);
    expect(await getStore().listDocs<Media>(paths.media(ORG, DST))).toHaveLength(1);
  });

  it('leaves out media the person cannot read, with a warning', async () => {
    await sites();
    const { clipboard } = await copyBlocks({ ...site(SRC), portal: PORTAL }, { page_id: 'home', block_ids: ['intro'] });
    const result = await pasteBlocks(writer(DST), parsePasteRequest({ clipboard, page_id: 'home', position: 0 }), { sourceAccess: readsNothing });
    expect(result.media).toMatchObject({ copied: 0, left_out: 1 });
    expect(result.report.warnings.some(warning => /loaf\.png.*cannot read/.test(warning))).toBe(true);
    expect(await getStore().listDocs<Media>(paths.media(ORG, DST))).toEqual([]);
    const blocks = await draftBlocks(DST);
    expect(blocks.map(block => block.type)).toEqual(['core/section', 'core/columns']);
    expect(JSON.stringify(blocks)).not.toContain('/media/');
    // The style is still created: it travels in the clipboard.
    expect(blocks[0]!.children![0]!.data.style_id).toBe('hero-2');
  });

  it('does not read a site with the same id in another organization', async () => {
    await sites();
    const { clipboard } = await copyBlocks({ ...site(SRC), portal: PORTAL }, { page_id: 'home', block_ids: ['intro'] });
    const elsewhere: SourceAccess = async () => ({ orgId: 'someone-else' });
    const result = await pasteBlocks(writer(DST), parsePasteRequest({ clipboard, page_id: 'home' }), { sourceAccess: elsewhere });
    expect(result.media.left_out).toBe(1);
  });

  it('pastes into the same site as it is: nothing imported, new ids, links and media kept', async () => {
    const stored = await sites();
    const { clipboard_text } = await copyBlocks({ ...site(SRC), portal: PORTAL }, { page_id: 'home', block_ids: ['intro', 'g', 'b'] });
    const result = await pasteBlocks(writer(SRC), parsePasteRequest({ clipboard: clipboard_text, page_id: 'home', after_block_id: 'b' }), { sourceAccess: readsNothing });
    expect(result.mode).toBe('same_site');
    expect(result.message).toBe('Pasted 3 blocks');
    expect(result.report.created.styles).toEqual([]);
    expect(result.report.created.global_blocks).toEqual([]);
    const blocks = await draftBlocks(SRC);
    expect(blocks.slice(0, 4).map(block => block.id)).toEqual(['intro', 'k', 'g', 'b']);
    const pasted = blocks.slice(4);
    expect(pasted.map(block => block.type)).toEqual(['core/section', 'core/global_block', 'core/button']);
    expect(pasted[0]!.children![0]!.data.style_id).toBe('hero');
    expect(pasted[0]!.children![1]!.data.html).toContain(stored.cdn_url);
    expect(pasted[1]!.data.global_block_id).toBe('promo');
    expect(pasted[2]!.data.page_id).toBe('about');
    expect(((await vstore.settings(ORG, SRC, MAIN_VERSION_ID)) as SiteSettings).styles!.map(style => style.id)).toEqual(['hero']);
    expect((await vstore.partials(ORG, SRC, MAIN_VERSION_ID)).map(partial => partial.id)).toEqual(['promo']);
  });

  it('refuses a paste without write permission, and invalid clipboards and positions', async () => {
    await sites();
    const { clipboard } = await copyBlocks({ ...site(SRC), portal: PORTAL }, { page_id: 'home', block_ids: ['k'] });
    await expect(pasteBlocks({ ...writer(DST), permission: 'read' }, parsePasteRequest({ clipboard, page_id: 'home' }), { sourceAccess: readsEverything }))
      .rejects.toMatchObject({ status: 403, code: 'clipboard_permission', message: expect.stringContaining('styles, block types, global blocks and media files') });
    expect(await vstore.blockType(ORG, DST, MAIN_VERSION_ID, 'acme-card')).toBeFalsy();
    expect(() => parsePasteRequest({ clipboard: 'hello', page_id: 'home' })).toThrow(expect.objectContaining({ status: 400, code: 'clipboard_invalid' }));
    expect(() => parsePasteRequest({ clipboard: { ...clipboard, typeroll_clipboard: 2 }, page_id: 'home' })).toThrow(/version 2/);
    expect(() => parsePasteRequest({ clipboard, page_id: 'home', after_block_id: 'left', position: 1 })).toThrow(/not both/);
    expect(() => parsePasteRequest({ clipboard, page_id: 'home', extra: 1 })).toThrow(/Unknown fields: extra/);
    await expect(pasteBlocks(writer(DST), parsePasteRequest({ clipboard, page_id: 'home', after_block_id: 'nope' }), { sourceAccess: readsEverything }))
      .rejects.toMatchObject({ status: 404, code: 'block_not_found' });
    await expect(pasteBlocks(writer(DST), parsePasteRequest({ clipboard, page_id: 'nope' }), { sourceAccess: readsEverything })).rejects.toMatchObject({ status: 404, code: 'page_not_found' });
    // Nothing was written by the refused pastes.
    expect(await vstore.blockType(ORG, DST, MAIN_VERSION_ID, 'acme-card')).toBeFalsy();
  });
});

describe('block clipboard over the public API', () => {
  async function key(siteId: string | null): Promise<string> {
    const { createApiKey } = await import('../../lib/api-keys');
    return (await createApiKey({ orgId: ORG, siteId, name: 'seed', createdBy: 'person@example.test' })).token;
  }
  async function call(route: 'copy' | 'paste', token: string, siteId: string, body: unknown) {
    const mod = await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/clipboard/${route}`) as unknown as Record<string, APIRoute>;
    const res = await mod.POST!({
      request: new Request(`${PORTAL}/api/v1/sites/${siteId}/clipboard/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
      params: { siteId },
    } as never) as Response;
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  }

  it('copies media across sites with an organization key, and not with a key for the target site only', async () => {
    await sites();
    const copied = await call('copy', await key(SRC), SRC, { page_id: 'home', block_ids: ['intro'] });
    expect(copied.status).toBe(200);
    expect(typeof copied.json.clipboard_text).toBe('string');

    // A key for the target site alone cannot read the source site: the image is left out.
    const siteKeyPaste = await call('paste', await key(DST), DST, { clipboard: copied.json.clipboard_text, page_id: 'home' });
    expect(siteKeyPaste.status).toBe(200);
    expect(siteKeyPaste.json.media).toMatchObject({ copied: 0, left_out: 1 });

    // The organization's key reads both sites: the image is copied.
    const orgKeyPaste = await call('paste', await key(null), DST, { clipboard: copied.json.clipboard, page_id: 'home', position: 0 });
    expect(orgKeyPaste.status).toBe(200);
    expect(orgKeyPaste.json.media).toMatchObject({ copied: 1, left_out: 0 });
    expect(orgKeyPaste.json.page.added_ids).toHaveLength(1);
    expect(await getStore().listDocs<Media>(paths.media(ORG, DST))).toHaveLength(1);

    expect((await call('paste', await key(DST), DST, { clipboard: 'not blocks', page_id: 'home' })).status).toBe(400);
    expect((await call('copy', await key(SRC), SRC, { page_id: 'home' })).status).toBe(400);
  });
});
