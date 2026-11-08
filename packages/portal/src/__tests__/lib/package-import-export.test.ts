vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => false) }));
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));
const access = vi.hoisted(() => ({ permission: 'write' as 'read' | 'write' | 'admin', owners: {} as Record<string, string> }));
vi.mock('../../lib/access', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/access')>()),
  requireSiteAccess: vi.fn(async (_cookies: unknown, siteId: string) => ({ ok: true as const, value: {
    session: { userId: 'u', email: 'editor@example.com' }, site: { id: siteId, status: 'live' }, versionId: 'main',
    owner_org_id: access.owners[siteId], permission: access.permission, design: access.permission === 'admin' } })) }));

// Typeroll packages end to end, offline: a block template exported from one
// site carries its media (as typeroll-media tokens), styles, block type and
// global block; importing it into a site of another organization creates
// them there through the normal private media path (R2 is an in-memory fake
// here), never maps styles to "nearest" ones, renames on conflicts and
// rewrites the content to the new ids. The full design needs admin and fonts
// need the importer's licence confirmation. Demo media is flagged and listed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { MAIN_VERSION_ID, paths, type Media, type SiteSettings, type SiteStyle } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { testTrueTypeFont } from '../helpers/font-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { createBlockTemplate, listBlockTemplates } from '../../lib/block-templates-store';
import { addSiteFont, listSiteFonts } from '../../lib/fonts/font-library';
import { defaultPackageMediaIO } from '../../lib/packages/package-media';
import { exportSitePackage, parseExportMeta, parseExportSelection } from '../../lib/packages/package-export';
import { importSitePackage, inspectSitePackage } from '../../lib/packages/package-import';
import { readSitePackageZip } from '../../lib/packages/package-zip';
import { demoMediaReferenced, publicationDemoMediaWarnings } from '../../lib/packages/demo-media';

const SRC_ORG = 'authororg', SRC = 'studio';
const DST_ORG = 'buyerorg', DST = 'bakery';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const photo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const objects = new Map<string, Uint8Array>();

const hero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 800 } };
const lead: SiteStyle = { id: 'lead', name: 'Lead', role: 'lead', targets: ['text'], base: { size: 'lg' } };
const note: SiteStyle = { id: 'note', name: 'Note', targets: ['text'], base: { size: 'sm' } };
const h1: SiteStyle = { id: 'h1', name: 'Heading 1', role: 'h1', targets: [], base: { weight: 900 } };

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

const ctxOf = (orgId: string, siteId: string) => ({ orgId, siteId, versionId: MAIN_VERSION_ID });
let mediaUrl = '';

async function sourceSite() {
  const store = getStore();
  await store.setDoc(paths.site(SRC_ORG, SRC), { name: 'Studio', created_at: '', media_id: 'srcmedia01' });
  await store.setDoc(paths.settings(SRC_ORG, SRC, MAIN_VERSION_ID), {
    site_name: 'Studio', language: 'en', colors: { primary: '#0a6b45' }, styles: [hero, lead, note, h1],
    fonts: { heading: 'Test Sans', body: 'Inter', size_base: 17 },
  } as unknown as Record<string, unknown>);
  const stored = await defaultPackageMediaIO.store(SRC_ORG, SRC, {
    bytes: photo, sha256: sha(photo), filename: 'photo.png', contentType: 'image/png', altText: 'A loaf',
    source: { package_id: 'none', package_version: '0', media_id: 'none' }, actor: 'author@example.com',
  });
  mediaUrl = stored.cdn_url;
  await vstore.writeBlockType(SRC_ORG, SRC, MAIN_VERSION_ID, 'acme-card', {
    id: 'acme-card', name: 'acme-card', label: 'Card', category: 'custom', container: false, origin: 'user', created_at: '2026-01-01T00:00:00Z',
    schema: [{ name: 'title', type: 'text', label: 'Title' }, { name: 'link', type: 'link', label: 'Link' }],
    template: '<div class="card"><h3>{{title}}</h3></div>',
  });
  await vstore.writePartial(SRC_ORG, SRC, MAIN_VERSION_ID, 'cta', {
    name: 'Call to action', kind: 'free', status: 'published', content_mode: 'blocks',
    blocks: [{ id: 'c1', type: 'core/prose', data: { html: '<p class="s-lead">Book a table</p>' } }],
  });
  await store.setDoc(paths.page(SRC_ORG, SRC, 'about', MAIN_VERSION_ID), { title: 'About', slug: 'about', content_type: 'page', content_mode: 'blocks', status: 'published', blocks: [] });
  await createBlockTemplate({ orgId: SRC_ORG, siteId: SRC }, {
    id: 'hero', name: 'Hero', kind: 'section', category: 'Heroes', preview: mediaUrl,
    blocks: [
      { id: 'h', type: 'core/rich_heading', data: { html: 'Fresh bread', level: 'h2', style_id: 'hero' } },
      { id: 'p', type: 'core/prose', data: { html: `<p><img src="${mediaUrl}" alt="A loaf"></p>` } },
      { id: 'k', type: 'acme-card', data: { title: 'Menu', link: { page_id: 'about' } } },
      { id: 'g', type: 'core/global_block', data: { global_block_id: 'cta' } },
    ],
  });
}

async function buyerSite(orgId = DST_ORG, siteId = DST, styles: SiteStyle[] = []) {
  await getStore().setDoc(paths.site(orgId, siteId), { name: 'Bakery', created_at: '', media_id: `${siteId}media1`.slice(0, 10) });
  await getStore().setDoc(paths.settings(orgId, siteId, MAIN_VERSION_ID), { site_name: 'Bakery', colors: { primary: '#222222' }, styles, fonts: { heading: 'Inter', body: 'Inter' } } as unknown as Record<string, unknown>);
}

async function exportHero(extra: Record<string, unknown> = {}) {
  return exportSitePackage(ctxOf(SRC_ORG, SRC), parseExportSelection({ kind: 'collection', block_templates: ['hero'], demo_media: [mediaIdOf(mediaUrl)], ...extra }),
    parseExportMeta({ id: 'acme-bakery', name: 'Acme bakery sections', version: '1.2.0', author: 'Acme Studio', licence: { name: 'Commercial' } }));
}
const mediaIdOf = (url: string) => /\/media\/([^/]+)\/content$/.exec(url)![1];
const settingsOf = async (orgId: string, siteId: string) => (await vstore.settings(orgId, siteId, MAIN_VERSION_ID)) as SiteSettings;

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
  access.permission = 'write';
  access.owners = { [SRC]: SRC_ORG, [DST]: DST_ORG };
  await sourceSite();
  await buyerSite();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('package export', () => {
  it('packages a template with its media, styles, block type and global block, and no site ids', async () => {
    const result = await exportHero();
    const { manifest, files } = await readSitePackageZip(result.zip);
    expect(result.filename).toBe('acme-bakery-1.2.0.typeroll');
    expect(manifest).toMatchObject({ kind: 'collection', id: 'acme-bakery', author: { name: 'Acme Studio' }, languages: ['en'] });
    const [template] = manifest.contents.block_templates!;
    const [media] = manifest.media;
    expect(media).toMatchObject({ sha256: sha(photo), content_type: 'image/png', filename: 'photo.png', alt_text: 'A loaf', demo: true });
    expect(Buffer.from(files.get(media.path)!).equals(Buffer.from(photo))).toBe(true);
    expect(template).toMatchObject({ kind: 'section', category: 'Heroes', preview: media.id });
    expect(JSON.stringify(template.blocks)).toContain(`typeroll-media:${media.id}`);
    // Styles the content uses only; the block type and global block it places.
    expect(manifest.contents.styles!.map(style => style.id).sort()).toEqual(['hero', 'lead']);
    expect(manifest.contents.block_types!.map(type => type.id)).toEqual(['acme-card']);
    expect(manifest.contents.block_types![0]).not.toHaveProperty('origin');
    expect(manifest.contents.global_blocks!.map(global => global.id)).toEqual(['cta']);
    // A link to a page of the source site keeps only its address.
    expect(template.blocks[2]!.data).toEqual({ title: 'Menu', link: { url: '/about' } });
    expect(result.warnings.join(' ')).toMatch(/plain addresses/);
    const text = JSON.stringify(manifest);
    for (const id of [SRC_ORG, SRC, mediaIdOf(mediaUrl), 'srcmedia01']) expect(text).not.toContain(id);
  });

  it('includes fonts only with the exporter\'s redistribution confirmation, and the design on request', async () => {
    await addSiteFont(SRC_ORG, SRC, { bytes: testTrueTypeFont(), licence_confirmed: true, by: 'author@example.com' });
    expect(() => parseExportSelection({ kind: 'collection', fonts: { families: ['Test Sans'] } })).toThrow(expect.objectContaining({ code: 'font_redistribution_unconfirmed' }));
    const result = await exportHero({ design: true, fonts: { families: ['Test Sans'], redistributable_confirmed: true } });
    const { manifest } = await readSitePackageZip(result.zip);
    expect(manifest.fonts).toEqual([expect.objectContaining({ family: 'Test Sans', redistributable: true, path: expect.stringMatching(/^fonts\/[a-f0-9]{64}\.woff2$/) })]);
    expect(manifest.contents.design).toMatchObject({ colors: { primary: '#0a6b45' }, fonts: { heading: 'Test Sans', body: 'Inter', size_base: 17 } });
    // With the design, the element styles travel too.
    expect(manifest.contents.styles!.map(style => style.id).sort()).toEqual(['h1', 'hero', 'lead']);
    await expect(exportHero({ fonts: { families: ['Inter'], redistributable_confirmed: true } })).rejects.toMatchObject({ code: 'package_selection_invalid' });
  });

  it('refuses unknown selections and meta', async () => {
    expect(() => parseExportSelection({ kind: 'collection', block_templates: ['nope'], extra: 1 })).toThrow(/Unknown selection keys/);
    expect(() => parseExportMeta({ id: 'Bad Id', name: 'x', version: '1' })).toThrow(/slug/);
    await expect(exportSitePackage(ctxOf(SRC_ORG, SRC), parseExportSelection({ kind: 'collection', block_templates: ['nope'] }), parseExportMeta({ id: 'x', name: 'X', version: '1' })))
      .rejects.toMatchObject({ code: 'package_selection_invalid' });
  });
});

describe('package import', () => {
  it('imports into a site of another organization: media through the private path, styles created, content rewritten', async () => {
    const { zip } = await exportHero();
    const report = await importSitePackage({ ...ctxOf(DST_ORG, DST), permission: 'write', actor: 'buyer@example.com' }, zip, { design: 'content' });
    expect(report.created).toMatchObject({ styles: ['hero', 'lead'], block_types: ['acme-card'], global_blocks: ['cta'], block_templates: ['hero'] });
    expect(report.created.media).toHaveLength(1);
    const media = await getStore().getDoc<Media & { package_source?: unknown }>(`${paths.media(DST_ORG, DST)}/${report.created.media[0]}`);
    expect(media).toMatchObject({ demo: true, sha256: sha(photo), storage: { state: 'ready' }, package_source: { package_id: 'acme-bakery', package_version: '1.2.0' } });
    expect(media!.cdn_url).toBe(`https://cms.example.com/api/sites/${DST}/media/${media!.id}/content`);
    const [template] = await listBlockTemplates({ orgId: DST_ORG, siteId: DST });
    expect(template).toMatchObject({ id: 'hero', kind: 'section', category: 'Heroes', preview: media!.cdn_url,
      imported_from: { package_id: 'acme-bakery', package_name: 'Acme bakery sections', version: '1.2.0', author: 'Acme Studio' } });
    expect(JSON.stringify(template.blocks)).toContain(media!.cdn_url);
    expect(JSON.stringify(template.blocks)).not.toContain('typeroll-media:');
    const settings = await settingsOf(DST_ORG, DST);
    expect(settings.styles!.map(style => style.id)).toEqual(['hero', 'lead']);
    expect(settings.colors).toEqual({ primary: '#222222' });
    expect(await vstore.blockType(DST_ORG, DST, MAIN_VERSION_ID, 'acme-card')).toMatchObject({ origin: 'third_party', imported_from: { package_name: 'Acme bakery sections', version: '1.2.0' } });
    expect(await vstore.partial(DST_ORG, DST, MAIN_VERSION_ID, 'cta')).toMatchObject({ kind: 'free', content_mode: 'blocks' });

    // Again: identical styles, the block type and the file are reused; the template is renamed.
    const again = await importSitePackage({ ...ctxOf(DST_ORG, DST), permission: 'write', actor: 'buyer@example.com' }, zip, { design: 'content' });
    expect(again.reused.styles.sort()).toEqual(['hero', 'lead']);
    expect(again.reused.block_types).toEqual(['acme-card']);
    expect(again.reused.media).toEqual(report.created.media);
    expect(again.created.block_templates).toEqual(['hero-2']);
    expect(again.renamed).toEqual(expect.arrayContaining([{ section: 'block_templates', from: 'hero', to: 'hero-2' }, { section: 'global_blocks', from: 'cta', to: 'cta-2' }]));
    const second = (await listBlockTemplates({ orgId: DST_ORG, siteId: DST })).find(entry => entry.id === 'hero-2')!;
    expect(JSON.stringify(second.blocks)).toContain('"global_block_id":"cta-2"');
  });

  it('creates a differing style under a new id instead of mapping it, and rewrites the content', async () => {
    await buyerSite(DST_ORG, DST, [{ id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 400 } }]);
    const { zip } = await exportHero();
    const inspected = await inspectSitePackage(DST_ORG, DST, MAIN_VERSION_ID, zip, { design: 'content' });
    expect(inspected.plan.styles).toEqual(expect.arrayContaining([{ action: 'rename', from: 'hero', to: 'hero-2', name: 'Hero (imported)' }]));
    expect(inspected.plan.maps.styles).toEqual({ hero: 'hero-2' });
    expect(inspected.needs).toEqual({ admin: false, design: false, font_licence: false });
    expect(inspected.package).toMatchObject({ id: 'acme-bakery', counts: { block_templates: 1, media: 1 } });
    expect(inspected.signature).toEqual({ status: 'unsigned' });
    await importSitePackage({ ...ctxOf(DST_ORG, DST), permission: 'write', actor: 'buyer@example.com' }, zip, { design: 'content' });
    const styles = (await settingsOf(DST_ORG, DST)).styles!;
    expect(styles.find(style => style.id === 'hero')!.base).toEqual({ weight: 400 });
    expect(styles.find(style => style.id === 'hero-2')).toMatchObject({ name: 'Hero (imported)', base: { weight: 800 } });
    const [template] = await listBlockTemplates({ orgId: DST_ORG, siteId: DST });
    expect(template.blocks[0]!.data).toMatchObject({ style_id: 'hero-2' });
  });

  it('needs admin for the full design and the importer\'s confirmation for font files', async () => {
    await addSiteFont(SRC_ORG, SRC, { bytes: testTrueTypeFont(), licence_confirmed: true, by: 'author@example.com' });
    const { zip } = await exportHero({ design: true, fonts: { families: ['Test Sans'], redistributable_confirmed: true } });
    const inspected = await inspectSitePackage(DST_ORG, DST, MAIN_VERSION_ID, zip, { design: 'full' });
    expect(inspected.needs).toEqual({ admin: true, design: true, font_licence: true });
    const buyer = { ...ctxOf(DST_ORG, DST), actor: 'buyer@example.com' };
    await expect(importSitePackage({ ...buyer, permission: 'write' }, zip, { design: 'full' })).rejects.toMatchObject({ status: 403, code: 'package_permission' });
    await expect(importSitePackage({ ...buyer, permission: 'admin' }, zip, { design: 'full' })).rejects.toMatchObject({ status: 400, code: 'font_licence_required' });
    // Nothing was written by the refused attempts.
    expect(await listBlockTemplates({ orgId: DST_ORG, siteId: DST })).toEqual([]);
    expect((await settingsOf(DST_ORG, DST)).colors).toEqual({ primary: '#222222' });

    const report = await importSitePackage({ ...buyer, permission: 'admin' }, zip, { design: 'full', font_licence_confirmed: true });
    expect(report.design?.updated).toEqual(expect.arrayContaining(['colors', 'fonts']));
    expect(report.created.fonts).toHaveLength(1);
    const settings = await settingsOf(DST_ORG, DST);
    expect(settings.colors).toEqual({ primary: '#0a6b45' });
    expect(settings.fonts).toMatchObject({ heading: 'Test Sans', body: 'Inter', size_base: 17 });
    expect(settings.styles!.find(style => style.role === 'h1')).toMatchObject({ base: { weight: 900 } });
    const [font] = await listSiteFonts(DST_ORG, DST);
    expect(font).toMatchObject({ family: 'Test Sans', licence: { confirmed: true, by: 'buyer@example.com', note: expect.stringContaining('Acme bakery sections') } });
  });

  it('imports the full design without fonts when the importer leaves them out', async () => {
    await addSiteFont(SRC_ORG, SRC, { bytes: testTrueTypeFont(), licence_confirmed: true, by: 'author@example.com' });
    const { zip } = await exportHero({ design: true, fonts: { families: ['Test Sans'], redistributable_confirmed: true } });
    const report = await importSitePackage({ ...ctxOf(DST_ORG, DST), permission: 'admin', actor: 'buyer@example.com' }, zip, { design: 'full', fonts: false });
    expect(report.created.fonts).toEqual([]);
    const settings = await settingsOf(DST_ORG, DST);
    expect(settings.colors).toEqual({ primary: '#0a6b45' });
    expect(settings.fonts).toMatchObject({ heading: 'Inter' });
  });

  it('reports what was written when a write fails part-way', async () => {
    const { zip } = await exportHero();
    const original = vstore.writePartial;
    vi.spyOn(vstore, 'writePartial').mockImplementation(async () => { throw new Error('storage unavailable'); });
    const failure = await importSitePackage({ ...ctxOf(DST_ORG, DST), permission: 'write', actor: 'buyer@example.com' }, zip, { design: 'content' }).catch(error => error);
    expect(failure).toMatchObject({ code: 'package_import_partial', details: { step: 'global_blocks', report: { created: { styles: ['hero', 'lead'], block_types: ['acme-card'], global_blocks: [] } } } });
    expect(failure.message).toMatch(/stays on the site/);
    void original;
  });
});

describe('signatures', () => {
  it('shows a trusted publisher as verified and anything else as unverified', async () => {
    const { signSitePackage } = await import('@typeroll/shared');
    const { writeSitePackageZip } = await import('../../lib/packages/package-zip');
    const { trustedPackageKeys } = await import('../../lib/packages/package-import');
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const public_jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const { manifest, files } = await readSitePackageZip((await exportHero()).zip);
    const signed = await signSitePackage(manifest, { key_id: 'acme-2026', private_jwk: await crypto.subtle.exportKey('jwk', keys.privateKey) });
    const zip = await writeSitePackageZip(signed, files);
    vi.stubEnv('TYPEROLL_PACKAGE_TRUSTED_KEYS', JSON.stringify([{ key_id: 'acme-2026', publisher: 'Acme Studio AB', public_jwk }, { key_id: 'broken' }]));
    expect(trustedPackageKeys()).toHaveLength(1);
    expect((await inspectSitePackage(DST_ORG, DST, MAIN_VERSION_ID, zip)).signature).toEqual({ status: 'verified', publisher: 'Acme Studio AB' });
    vi.stubEnv('TYPEROLL_PACKAGE_TRUSTED_KEYS', 'not json');
    expect(trustedPackageKeys()).toEqual([]);
    const unknown = await inspectSitePackage(DST_ORG, DST, MAIN_VERSION_ID, zip);
    expect(unknown.signature).toEqual({ status: 'unknown_key' });
    expect(unknown.warnings.join(' ')).toMatch(/not verified/);
  });
});

describe('site packages', () => {
  it('copies a whole site: pages, header, menus, site fields with values, and the design', async () => {
    await vstore.writePartial(SRC_ORG, SRC, MAIN_VERSION_ID, 'header', { name: 'Header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [{ id: 'hd', type: 'core/prose', data: { html: '<p>Studio</p>' } }] });
    await getStore().setDoc(paths.page(SRC_ORG, SRC, 'home', MAIN_VERSION_ID), { title: 'Home', slug: '', content_type: 'page', content_mode: 'blocks', status: 'published', seo_title: 'Welcome', og_image: mediaUrl,
      blocks: [{ id: 'hh', type: 'core/rich_heading', data: { html: 'Hello', level: 'h1', style_id: 'hero' } }, { id: 'hl', type: 'acme-card', data: { title: 'About us', link: { page_id: 'about' } } }] });
    await getStore().setDoc(paths.page(SRC_ORG, SRC, 'team', MAIN_VERSION_ID), { title: 'Team', slug: 'team', parent: 'about', content_type: 'page', content_mode: 'blocks', status: 'draft', blocks: [] });
    await vstore.writeMenu(SRC_ORG, SRC, MAIN_VERSION_ID, { id: 'main', name: 'Main', locations: ['primary'], items: [{ id: 'i1', type: 'page', page_id: 'about' }, { id: 'i2', type: 'url', href: 'https://example.com', label: 'Shop' }] });
    await vstore.writeSiteFields(SRC_ORG, SRC, MAIN_VERSION_ID, { groups: [{ id: 'contact', label: 'Contact', fields: [{ name: 'phone', type: 'text', label: 'Phone' }] }], values: { phone: '+46 8 123 45' } });
    const exported = await exportSitePackage(ctxOf(SRC_ORG, SRC), parseExportSelection({ kind: 'site' }), parseExportMeta({ id: 'studio-site', name: 'Studio', version: '1' }));
    const { manifest } = await readSitePackageZip(exported.zip);
    expect(manifest.kind).toBe('site');
    expect(manifest.contents.pages!.map(page => page.id).sort()).toEqual(['about', 'home', 'team']);
    expect(manifest.contents.pages!.find(page => page.id === 'home')).toMatchObject({ seo: { seo_title: 'Welcome', og_image: expect.stringMatching(/^typeroll-media:/) } });
    expect(manifest.contents.global_blocks!.map(global => global.kind).sort()).toEqual(['free', 'header']);
    expect(manifest.contents.site_field_values).toEqual({ phone: '+46 8 123 45' });

    // Into a site that already has an About page and a primary menu.
    await getStore().setDoc(paths.page(DST_ORG, DST, 'about', MAIN_VERSION_ID), { title: 'Our story', slug: 'about', content_type: 'page', content_mode: 'blocks', status: 'published', blocks: [] });
    await vstore.writeMenu(DST_ORG, DST, MAIN_VERSION_ID, { id: 'nav', name: 'Nav', locations: ['primary'], items: [] });
    const report = await importSitePackage({ ...ctxOf(DST_ORG, DST), permission: 'admin', actor: 'buyer@example.com' }, exported.zip, { design: 'full', fonts: false });
    expect(report.created.pages.sort()).toEqual(['about-2', 'home', 'team']);
    expect(report.created.menus).toEqual(['main']);
    expect(report.created.site_field_groups).toEqual(['contact']);
    // The buyer's site had no header: the package's becomes it.
    expect(report.created.global_blocks.sort()).toEqual(['cta', 'header']);
    expect(report.warnings.join(' ')).toMatch(/imported as \/about-2/);
    const team = await vstore.page(DST_ORG, DST, MAIN_VERSION_ID, 'team');
    expect(team).toMatchObject({ parent: 'about-2', status: 'draft' });
    const home = await vstore.page(DST_ORG, DST, MAIN_VERSION_ID, 'home');
    expect(home!.og_image).toMatch(new RegExp(`/api/sites/${DST}/media/`));
    expect(JSON.stringify(home!.blocks)).toContain('"page_id":"about-2"');
    expect(await vstore.menu(DST_ORG, DST, MAIN_VERSION_ID, 'main')).toMatchObject({ items: [{ type: 'page', page_id: 'about-2' }, { type: 'url' }] });
    expect((await vstore.menu(DST_ORG, DST, MAIN_VERSION_ID, 'main'))!.locations ?? []).toEqual([]);
    expect(await vstore.partial(DST_ORG, DST, MAIN_VERSION_ID, 'header')).toMatchObject({ kind: 'header', blocks: [{ data: { html: '<p>Studio</p>' } }] });
    expect(await vstore.siteFields(DST_ORG, DST, MAIN_VERSION_ID)).toMatchObject({ values: { phone: '+46 8 123 45' } });
  });
});

describe('demo media', () => {
  it('lists demo files that content uses, for readiness and the publication', async () => {
    const { zip } = await exportHero();
    const report = await importSitePackage({ ...ctxOf(DST_ORG, DST), permission: 'write', actor: 'buyer@example.com' }, zip, { design: 'content' });
    const library = await getStore().listDocs<Media>(paths.media(DST_ORG, DST));
    const used = demoMediaReferenced(library, [{ blocks: [{ id: 'x', type: 'core/image', data: { src: library[0]!.cdn_url } }] }]);
    expect(used.map(media => media.id)).toEqual(report.created.media);
    expect(demoMediaReferenced(library, { blocks: [] })).toEqual([]);
    expect(publicationDemoMediaWarnings(used)[0]).toMatch(/1 demo image from a template package is published \(photo\.png\)/);

    const { buildSiteReadiness } = await import('../../lib/site-readiness');
    const page = { id: 'home', title: 'Home', slug: '', path: '/', content_type: 'page', content_mode: 'blocks', status: 'published', blocks: [{ id: 'i', type: 'core/image', data: { src: library[0]!.cdn_url } }] };
    const readiness = buildSiteReadiness({ siteId: DST, settings: { site_name: 'Bakery' } as SiteSettings, pages: [page as never], partials: [], templates: [], contentTypes: [], blockTypes: [], media: library, apps: null, links: { links: [] }, zone: { status: 'unavailable', host: '' } as never });
    expect(readiness.items.find(entry => entry.id === 'demo_media')).toMatchObject({ status: 'warning', details: [expect.stringContaining('photo.png')] });

    // Keeping the file clears the flag; setting it is refused.
    const fresh = await import('../../pages/api/sites/[siteId]/media/[mediaId]') as unknown as Record<string, APIRoute>;
    const put = (body: unknown) => fresh.PUT!({ request: new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params: { siteId: DST, mediaId: library[0]!.id }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
    expect((await put({ demo: true })).status).toBe(400);
    expect((await put({ demo: false })).status).toBe(200);
    expect((await getStore().getDoc<Media>(`${paths.media(DST_ORG, DST)}/${library[0]!.id}`))!.demo).toBe(false);
  });
});

describe('package routes', () => {
  async function v1(path: string, method: 'GET' | 'POST', token: string, body?: unknown, params: Record<string, string> = {}): Promise<Response> {
    const mod = (await import(/* @vite-ignore */ `../../pages/api/v1/sites/[siteId]/packages/${path}`)) as Record<string, APIRoute>;
    const request = new Request(`http://localhost/api/v1/sites/${SRC}/packages/${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return mod[method]!({ request, params: { siteId: SRC, ...params }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
  }

  it('exports over v1 to a signed one-hour download, and inspects and imports JSON bodies', async () => {
    const { createApiKey } = await import('../../lib/api-keys');
    const admin = (await createApiKey({ orgId: SRC_ORG, siteId: SRC, name: 'admin', createdBy: 'admin' })).token;
    const selection = { kind: 'collection', block_templates: ['hero'] };
    const meta = { id: 'acme-bakery', name: 'Acme', version: '1.0.0' };
    const exported = await v1('export', 'POST', admin, { selection, meta });
    expect(exported.status).toBe(200);
    const body = await exported.json() as { download_url: string; filename: string; bytes: number; sha256: string; expires_at: string };
    expect(body).toMatchObject({ filename: 'acme-bakery-1.0.0.typeroll', download_url: expect.stringMatching(/^https:\/\/cms\.example\.com\/api\/v1\/sites\/studio\/packages\/downloads\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/) });
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    const token = body.download_url.split('/').pop()!;
    const download = await import('../../pages/api/v1/sites/[siteId]/packages/downloads/[token]') as unknown as Record<string, APIRoute>;
    const get = (siteId: string, value: string) => download.GET!({ request: new Request('http://localhost/'), params: { siteId, token: value }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
    const file = await get(SRC, token);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/vnd.typeroll.package+zip');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(sha(bytes)).toBe(body.sha256);
    expect((await readSitePackageZip(bytes)).manifest.id).toBe('acme-bakery');
    expect((await get(SRC, `${token.slice(0, -2)}xx`)).status).toBe(404);
    expect((await get('another-site', token)).status).toBe(404);

    // A whole site needs admin; a read key exports nothing.
    const { writeShare } = await import('../../lib/shares');
    await writeShare({ id: 'share-r', site_id: SRC, owner_org_id: SRC_ORG, shared_with_org_id: 'readerorg', permission: 'read', created_at: Date.now(), created_by: 'author@example.com' });
    await writeShare({ id: 'share-w', site_id: SRC, owner_org_id: SRC_ORG, shared_with_org_id: 'writerorg', permission: 'write', created_at: Date.now(), created_by: 'author@example.com' });
    const reader = (await createApiKey({ orgId: 'readerorg', siteId: null, name: 'reader', createdBy: 'reader' })).token;
    const writer = (await createApiKey({ orgId: 'writerorg', siteId: null, name: 'writer', createdBy: 'writer' })).token;
    expect((await v1('export', 'POST', writer, { selection: { kind: 'site' }, meta })).status).toBe(403);
    expect((await v1('export', 'POST', writer, { selection, meta })).status).toBe(200);
    const refused = await v1('export', 'POST', reader, { selection, meta });
    expect(refused.status).toBe(403);

    const data_base64 = Buffer.from(bytes).toString('base64');
    const inspected = await v1('inspect', 'POST', admin, { data_base64, options: { design: 'content' } });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ package: { id: 'acme-bakery' }, plan: { block_templates: [{ action: 'rename', from: 'hero', to: 'hero-2' }] } });
    const imported = await v1('import', 'POST', admin, { data_base64, options: { design: 'content' } });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ report: { created: { block_templates: ['hero-2'] }, reused: { styles: ['hero', 'lead'] } } });
    const both = await v1('import', 'POST', admin, { data_base64, source_url: 'https://example.com/a.typeroll' });
    expect(both.status).toBe(400);
  });

  it('downloads a zip from the session export route and imports a multipart upload', async () => {
    const call = async (route: string, siteId: string, init: RequestInit) => {
      const mod = (await import(/* @vite-ignore */ `../../pages/api/sites/[siteId]/packages/${route}`)) as Record<string, APIRoute>;
      return mod[init.method ?? 'GET']!({ request: new Request(`http://localhost/api/sites/${siteId}/packages/${route}`, init), params: { siteId }, cookies: { get: () => undefined }, locals: {} } as never) as Promise<Response>;
    };
    const site = await call('export', SRC, { method: 'POST', body: JSON.stringify({ selection: { kind: 'site' }, meta: { id: 'studio', name: 'Studio', version: '1' } }) });
    expect(site.status).toBe(403);
    const exported = await call('export', SRC, { method: 'POST', body: JSON.stringify({ selection: { kind: 'collection', block_templates: ['hero'] }, meta: { id: 'acme', name: 'Acme', version: '2.0' } }) });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toBe('attachment; filename="acme-2.0.typeroll"');
    const zip = new Uint8Array(await exported.arrayBuffer());
    const exportable = await (await call('exportable', SRC, { method: 'GET' })).json() as Record<string, unknown[]>;
    expect(exportable.block_templates).toEqual([{ id: 'hero', name: 'Hero', kind: 'section', category: 'Heroes' }]);
    expect(exportable.font_families).toEqual(expect.arrayContaining([{ family: 'Test Sans', source: 'catalog' }]));
    const form = new FormData();
    form.set('file', new File([zip], 'acme-2.0.typeroll'));
    form.set('options', JSON.stringify({ design: 'content' }));
    const imported = await call('import', DST, { method: 'POST', body: form });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ report: { created: { block_templates: ['hero'] } } });
    const full = new FormData();
    full.set('file', new File([zip], 'acme-2.0.typeroll'));
    full.set('options', JSON.stringify({ design: 'full' }));
    expect((await call('import', DST, { method: 'POST', body: full })).status).toBe(403);
  });
});
