vi.mock('../../lib/media/remote-transfer', () => ({ remoteTransfersEnabled: vi.fn(async () => false) }));
vi.mock('../../lib/publishing/media-migration-queue', () => ({ enqueueMediaMigration: vi.fn(async () => {}) }));
const access = vi.hoisted(() => ({ session: { userId: 'u1', email: 'maker@example.com', orgId: 'agency' }, owners: {} as Record<string, string> }));
vi.mock('../../lib/access', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/access')>()),
  requireFullSession: vi.fn(async () => ({ ok: true as const, value: access.session })),
  requireSiteAccess: vi.fn(async (_cookies: unknown, siteId: string) => {
    const owner = access.owners[siteId];
    if (!owner) return { ok: false as const, response: new Response('{"error":"Not found"}', { status: 404 }) };
    return { ok: true as const, value: { session: access.session, site: { id: siteId }, versionId: 'main', owner_org_id: owner, permission: 'admin', design: true, is_owner: owner === access.session.orgId } };
  }) }));
vi.mock('../../lib/api-auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api-auth')>()),
  requireAnyApiKey: vi.fn(async (request: Request) => ({ ok: true as const, value: {
    orgId: 'agency', tokenOrgId: 'agency', tokenSiteId: null, siteId: '', site: { id: '' }, versionId: 'main', keyPrefix: 'trk_test', permission: 'admin', request, path: '/api/v1/sites',
  } })) }));

// A new site from a template, offline: from a whole-site package (a file or
// a collection entry) and from another site of the same organization. The
// package is imported into the new site's empty main version, so ids are
// kept, styles are created (never renamed against the default ones) and
// media are copied through the normal private media path (R2 is an
// in-memory fake). A site copy strips the source's infrastructure. A failed
// import removes the half-created site.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '../../lib/net/s3';
import type { APIContext } from 'astro';
import { createHash } from 'node:crypto';
import { MAIN_VERSION_ID, paths, type Media, type Page, type SiteSettings, type SiteStyle } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { testTrueTypeFont } from '../helpers/font-fixtures';
import { getStore } from '../../lib/datastore';
import { vstore } from '../../lib/version-store';
import { addSiteFont, listSiteFonts } from '../../lib/fonts/font-library';
import { defaultPackageMediaIO, type PackageMediaIO } from '../../lib/packages/package-media';
import { exportSitePackage, parseExportMeta, parseExportSelection } from '../../lib/packages/package-export';
import { addPackageToCollection } from '../../lib/collections/collections';
import { createSite, newSiteStylesBeside } from '../../lib/site-create';
import { assertNewSiteSource, loadNewSiteSource, parseNewSiteFrom, parseNewSiteImportOptions, siteCopySettings, type NewSiteSource } from '../../lib/packages/new-site-source';
import { apiNewSiteFrom } from '../../lib/packages/new-site-requests';
import { readSitePackageZip } from '../../lib/packages/package-zip';

const AUTHOR_ORG = 'authororg', AUTHOR = 'studio';
const ORG = 'agency', OTHER_ORG = 'otherorg';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const photo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5, 4, 3, 2]);
const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 2, 3, 5, 8, 13, 21]);
const objects = new Map<string, Uint8Array>();

const hero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { weight: 800 } };
// The package's own "eyebrow", differing from the standard one: kept as it is, never "eyebrow-2".
const eyebrow: SiteStyle = { id: 'eyebrow', name: 'Eyebrow', role: 'eyebrow', targets: ['heading', 'text'], base: { size: 'xs', weight: 700 } };
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

const store = () => getStore();
const settingsOf = async (orgId: string, siteId: string) => (await vstore.settings(orgId, siteId, MAIN_VERSION_ID)) as SiteSettings;
const mediaOf = (orgId: string, siteId: string) => store().listDocs<Media>(paths.media(orgId, siteId));
async function upload(orgId: string, siteId: string, bytes: Uint8Array, filename: string, demo = false) {
  const stored = await defaultPackageMediaIO.store(orgId, siteId, {
    bytes, sha256: sha(bytes), filename, contentType: 'image/png', altText: filename, demo,
    source: { package_id: 'none', package_version: '0', media_id: 'none' }, actor: 'author@example.com',
  });
  return stored.cdn_url;
}

/** A template site of another organization, exported as a whole-site package. */
async function templatePackage(): Promise<Uint8Array> {
  await store().setDoc(paths.site(AUTHOR_ORG, AUTHOR), { name: 'Studio', created_at: '', media_id: 'srcmedia01' });
  await store().setDoc(paths.settings(AUTHOR_ORG, AUTHOR, MAIN_VERSION_ID), {
    site_name: 'Studio', language: 'sv', render_version: 12, colors: { primary: '#0a6b45' }, styles: [hero, eyebrow, h1], fonts: { heading: 'Inter', body: 'Inter', size_base: 17 },
  } as unknown as Record<string, unknown>);
  const image = await upload(AUTHOR_ORG, AUTHOR, photo, 'bread.png', true);
  await vstore.writePartial(AUTHOR_ORG, AUTHOR, MAIN_VERSION_ID, 'header', { name: 'Header', kind: 'header', status: 'published', content_mode: 'blocks', blocks: [{ id: 'hd', type: 'core/prose', data: { html: '<p>Studio</p>' } }] });
  await store().setDoc(paths.page(AUTHOR_ORG, AUTHOR, 'home', MAIN_VERSION_ID), { title: 'Home', slug: '', content_type: 'page', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'hh', type: 'core/rich_heading', data: { html: 'Fresh bread', level: 'h1', style_id: 'hero' } }, { id: 'im', type: 'core/image', data: { src: image, alt: 'Bread' } }] });
  await store().setDoc(paths.page(AUTHOR_ORG, AUTHOR, 'menu', MAIN_VERSION_ID), { title: 'Menu', slug: 'menu', content_type: 'page', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'ey', type: 'core/rich_heading', data: { html: 'Today', level: 'h2', style_id: 'eyebrow' } }] });
  await vstore.writeMenu(AUTHOR_ORG, AUTHOR, MAIN_VERSION_ID, { id: 'main', name: 'Main', locations: ['primary'], items: [{ id: 'i1', type: 'page', page_id: 'menu' }, { id: 'i2', type: 'url', href: 'https://example.com', label: 'Shop' }] });
  await vstore.writeSiteFields(AUTHOR_ORG, AUTHOR, MAIN_VERSION_ID, { groups: [{ id: 'contact', label: 'Contact', fields: [{ name: 'phone', type: 'text', label: 'Phone' }] }], values: { phone: '+46 8 123 45' } });
  const { zip } = await exportSitePackage({ orgId: AUTHOR_ORG, siteId: AUTHOR, versionId: MAIN_VERSION_ID }, parseExportSelection({ kind: 'site' }),
    parseExportMeta({ id: 'bakery-site', name: 'Bakery site', version: '2.0.0', author: 'Acme Studio', licence: { name: 'Commercial' } }));
  return zip;
}

/** A site of the agency to copy: content, media and the infrastructure that must not travel. */
async function clientSite(siteId = 'client-a', orgId = ORG) {
  await store().setDoc(paths.site(orgId, siteId), {
    name: 'Client A', created_at: '', media_id: `${siteId}m`.slice(0, 10), domain: 'client-a.example', staging_url: 'https://staging.client-a.example',
    hosting_config: { fallback_subdomain: 'client-a' }, ai_scripts_enabled: true,
  });
  const logoUrl = await upload(orgId, siteId, logo, 'logo.png');
  const image = await upload(orgId, siteId, photo, 'team.png');
  await store().setDoc(paths.settings(orgId, siteId, MAIN_VERSION_ID), {
    site_name: 'Client A', language: 'nl', time_zone: 'Europe/Amsterdam', render_version: 14, colors: { primary: '#aa0000' }, styles: [hero],
    fonts: { heading: 'Inter', body: 'Inter', size_base: 16, services: [{ provider: 'adobe', id: 'abc1234', families: ['Proxima Nova'] }], smoothing: 'antialiased' },
    tagline: 'Since 1990', logo: logoUrl, contact: { email: 'hello@client-a.example' },
    scripts_head: '<script async src="https://www.googletagmanager.com/gtag/js?id=G-SOURCE"></script>', scripts_body_end: '<script>track()</script>',
    cookie_consent: { enabled: true, privacy_policy_url: '/privacy', scripts_optional: '<script src="https://tracker.example/x.js?id=SOURCE"></script>' },
    robots_txt: 'User-agent: *\nSitemap: https://client-a.example/sitemap.xml\n', sitewide_noindex: true,
    external_routes: [{ path: '/shop', owner: 'shopify' }], extension_public_config: { 'booking-app': { calendar: 'x' } },
    custom_css: '.brand{letter-spacing:1px}', default_seo_suffix: ' — Client A',
  } as unknown as Record<string, unknown>);
  await store().setDoc(paths.page(orgId, siteId, 'home', MAIN_VERSION_ID), { title: 'Home', slug: 'home', content_type: 'page', content_mode: 'html', status: 'published',
    html_content: `<h1>Client A</h1><p><img src="${image}" alt="Team"></p>`, canonical_url: 'https://client-a.example/' });
  await store().setDoc(paths.page(orgId, siteId, 'about', MAIN_VERSION_ID), { title: 'About', slug: 'about', content_type: 'page', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'a1', type: 'core/rich_heading', data: { html: 'About', level: 'h1', style_id: 'hero' } }, { id: 'a2', type: 'core/form', data: { form_id: 'contact' } }] });
  await vstore.writeContentType(orgId, siteId, MAIN_VERSION_ID, 'news', { name: 'news', label_singular: 'News item', label_plural: 'News', route_template: '/news/{slug}', fields: [], created_at: '2026-01-01T00:00:00Z' });
  await store().setDoc(paths.page(orgId, siteId, 'opening', MAIN_VERSION_ID), { title: 'We are open', slug: 'opening', content_type: 'news', content_mode: 'blocks', status: 'published',
    blocks: [{ id: 'n1', type: 'core/image', data: { src: image, alt: 'Shop' } }] });
  await vstore.writeMenu(orgId, siteId, MAIN_VERSION_ID, { id: 'primary', name: 'Main', locations: ['primary'], items: [{ id: 'h', type: 'page', page_id: 'home' }, { id: 'n', type: 'page', page_id: 'opening' }] });
  await store().setDoc(`${paths.forms(orgId, siteId)}/contact`, { name: 'Contact', created_at: '', submit_text: 'Send',
    actions: [{ type: 'webhook', config: { url: 'https://hooks.example/abc', secret_enc: 'encrypted-secret' } }], steps: [{ id: 's1', blocks: [] }] });
  await store().setDoc(paths.snippet(orgId, siteId, 'notice'), { name: 'Notice', kind: 'text', format: 'text', content: 'Closed on Monday', updated_at: '2026-01-01T00:00:00Z' });
  await store().setDoc(`${paths.extensionInstallations(orgId, siteId)}/inst1`, { extension_id: 'booking-app', status: 'enabled', owner_org_id: orgId, site_id: siteId, secret_config_enc: { key: 'x' } });
  await store().setDoc(`${paths.apiKeys(orgId, siteId)}/trk_abc`, { name: 'Deploy key', key_hash: 'h' });
  await store().setDoc(`${paths.shares(orgId, siteId)}/share1`, { grantee_org_id: 'client', permission: 'write' });
  await store().setDoc(paths.integrations(orgId, siteId), { email: { provider: 'smtp', password_enc: 'x' } });
  return { logoUrl, image };
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
  access.owners = {};
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const fromPackage = async (bytes: Uint8Array, options = parseNewSiteImportOptions(undefined)) => ({ source: await loadNewSiteSource(ORG, { kind: 'package', bytes }, options), options });

describe('a new site from a whole-site package', () => {
  it('imports pages, header, menus, styles, site fields with values and media, without the default seed', async () => {
    const zip = await templatePackage();
    const { siteId, site, started_from } = await createSite({ orgId: ORG, name: 'Corner Bakery', from: await fromPackage(zip), actor: 'maker@example.com' });
    expect(siteId).toBe('corner-bakery');
    // The package's language, render version and design.
    expect(site.language).toBe('sv');
    const settings = await settingsOf(ORG, siteId);
    expect(settings).toMatchObject({ site_name: 'Corner Bakery', language: 'sv', time_zone: 'Europe/Stockholm', render_version: 12, colors: { primary: '#0a6b45' }, fonts: { size_base: 17 } });
    // Styles keep their ids: the package's eyebrow and h1 replace the standard ones, nothing is renamed.
    const styles = settings.styles!;
    expect(styles.filter(style => style.id === 'eyebrow')).toEqual([expect.objectContaining({ base: { size: 'xs', weight: 700 } })]);
    expect(styles.filter(style => style.role === 'h1')).toEqual([expect.objectContaining({ id: 'h1', base: { weight: 900 } })]);
    expect(styles.some(style => /-2$/.test(style.id) || / \(imported\)$/.test(style.name))).toBe(false);
    expect(styles.some(style => style.id === 'hero')).toBe(true);
    expect(styles.some(style => style.role === 'body')).toBe(true);

    // Pages with their ids, no second home page, the menu with its page item.
    const pages = await vstore.pages(ORG, siteId, MAIN_VERSION_ID);
    expect(pages.map(page => page.id).sort()).toEqual(['home', 'menu']);
    expect(pages.find(page => page.id === 'home')).toMatchObject({ content_mode: 'blocks', slug: '' });
    expect(await vstore.menu(ORG, siteId, MAIN_VERSION_ID, 'main')).toMatchObject({ locations: ['primary'], items: [{ type: 'page', page_id: 'menu' }, { type: 'url', href: 'https://example.com' }] });
    const menus = await vstore.menus(ORG, siteId, MAIN_VERSION_ID);
    expect(menus.map(menu => menu.id).sort()).toEqual(['footer', 'main']);
    expect(menus.find(menu => menu.id === 'footer')!.items).toEqual([{ id: 'home', type: 'page', page_id: 'home' }]);
    // The header is the package's; the package has no footer, so the starter one is added.
    expect(await vstore.partial(ORG, siteId, MAIN_VERSION_ID, 'header')).toMatchObject({ kind: 'header', blocks: [{ data: { html: '<p>Studio</p>' } }] });
    expect(await vstore.partial(ORG, siteId, MAIN_VERSION_ID, 'footer')).toMatchObject({ kind: 'footer', status: 'published' });
    expect(started_from!.defaults).toEqual(['footer', 'footer menu']);
    expect(await vstore.siteFields(ORG, siteId, MAIN_VERSION_ID)).toMatchObject({ groups: [{ id: 'contact' }], values: { phone: '+46 8 123 45' } });

    // The image is in the new site's library, still marked as demo content, and the page uses its address.
    const library = await mediaOf(ORG, siteId);
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({ demo: true, sha256: sha(photo), storage: { state: 'ready' }, package_source: { package_id: 'bakery-site', package_version: '2.0.0' } });
    expect(library[0]!.cdn_url).toBe(`https://cms.example.com/api/sites/${siteId}/media/${library[0]!.id}/content`);
    expect(JSON.stringify(pages.find(page => page.id === 'home')!.blocks)).toContain(library[0]!.cdn_url);
    expect(started_from).toMatchObject({ kind: 'package', source: { name: 'Bakery site', version: '2.0.0', package_id: 'bakery-site' }, report: { created: { pages: ['home', 'menu'] } } });
    expect(started_from!.warnings.join(' ')).toMatch(/not signed/);
  });

  it('keeps the default look with design "content" and starts from a collection entry', async () => {
    const zip = await templatePackage();
    const { entries } = await addPackageToCollection(ORG, zip, { label: 'maker@example.com' });
    expect(entries).toEqual([expect.objectContaining({ kind: 'package' })]);
    const options = parseNewSiteImportOptions({ design: 'content' });
    const source = await loadNewSiteSource(ORG, { kind: 'collection_entry', entry_id: entries[0]!.id }, options);
    const { siteId, started_from } = await createSite({ orgId: ORG, name: 'Second Bakery', language: 'en', from: { source, options } });
    const settings = await settingsOf(ORG, siteId);
    expect(settings.language).toBe('en');
    expect(settings.colors.primary).toBe('#2563eb');
    // The standard element styles stay; the content's styles come with it.
    expect(settings.styles!.filter(style => style.role === 'h1')).toHaveLength(1);
    expect(settings.styles!.find(style => style.role === 'h1')!.base).not.toEqual({ weight: 900 });
    expect(settings.styles!.find(style => style.id === 'eyebrow')!.base).toEqual({ size: 'xs', weight: 700 });
    expect(started_from).toMatchObject({ kind: 'collection_entry', source: { collection_entry: entries[0]!.id } });
    expect(await vstore.page(ORG, siteId, MAIN_VERSION_ID, 'menu')).toBeTruthy();
  });

  it('picks the standard styles a package does not replace', () => {
    const pkg = { contents: { styles: [eyebrow, h1, { id: 'intro', name: 'Intro', role: 'lead', targets: ['text'] }] } } as never;
    const full = newSiteStylesBeside(pkg, 'full');
    expect(full.some(style => style.id === 'eyebrow' || style.role === 'h1' || style.role === 'lead')).toBe(false);
    expect(full.some(style => style.role === 'body')).toBe(true);
    const content = newSiteStylesBeside(pkg, 'content');
    expect(content.some(style => style.role === 'h1')).toBe(true);
    expect(content.some(style => style.id === 'eyebrow')).toBe(false);
  });

  it('refuses before creating anything: font files without the licence confirmation, an invalid signature, a package that is not a site', async () => {
    await templatePackage();
    await addSiteFont(AUTHOR_ORG, AUTHOR, { bytes: testTrueTypeFont(), licence_confirmed: true, by: 'author@example.com' });
    const { zip } = await exportSitePackage({ orgId: AUTHOR_ORG, siteId: AUTHOR, versionId: MAIN_VERSION_ID },
      parseExportSelection({ kind: 'site', fonts: { families: ['Test Sans'], redistributable_confirmed: true } }), parseExportMeta({ id: 'fonts-site', name: 'Fonts site', version: '1' }));
    await expect(createSite({ orgId: ORG, name: 'Font Site', from: await fromPackage(zip) })).rejects.toMatchObject({ code: 'font_licence_required' });
    expect(await store().listDocs(paths.sites(ORG))).toEqual([]);
    // Confirmed, the font is added to the new site's Fonts library; or left out with fonts: false.
    const confirmed = await createSite({ orgId: ORG, name: 'Font Site', from: await fromPackage(zip, parseNewSiteImportOptions({ font_licence_confirmed: true })) });
    expect((await listSiteFonts(ORG, confirmed.siteId)).map(font => font.family)).toEqual(['Test Sans']);
    const without = await createSite({ orgId: ORG, name: 'No Fonts', from: await fromPackage(zip, parseNewSiteImportOptions({ fonts: false })) });
    expect(await listSiteFonts(ORG, without.siteId)).toEqual([]);

    const source = (await fromPackage(zip)).source;
    expect(() => assertNewSiteSource({ ...source, signature: { status: 'invalid' } } as NewSiteSource, { design: 'content' })).toThrow(expect.objectContaining({ code: 'package_signature_invalid' }));
    const { manifest, files } = await readSitePackageZip(zip);
    expect(() => assertNewSiteSource({ ...source, read: { manifest: { ...manifest, kind: 'collection' }, files } }, { design: 'content' })).toThrow(expect.objectContaining({ code: 'package_not_a_site' }));
  });

  it('removes the half-created site when the import fails', async () => {
    const zip = await templatePackage();
    const failing: PackageMediaIO = { ...defaultPackageMediaIO, store: async () => { throw new Error('storage is down'); } };
    const error = await createSite({ orgId: ORG, name: 'Broken Bakery', from: await fromPackage(zip), media: failing }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'site_create_failed', status: 500, details: expect.objectContaining({ site_removed: true, cause_code: 'package_import_partial', step: 'media' }) });
    expect(error.message).toMatch(/could not be created from the package "Bakery site"[\s\S]*storage is down[\s\S]*removed again/);
    expect(await store().getDoc(paths.site(ORG, 'broken-bakery'))).toBeNull();
    expect(await store().getDoc(paths.settings(ORG, 'broken-bakery'))).toBeNull();
    expect(await vstore.pages(ORG, 'broken-bakery', MAIN_VERSION_ID)).toEqual([]);

    // A failure after a file was stored removes the file and its object too.
    let calls = 0;
    const late: PackageMediaIO = { ...defaultPackageMediaIO, store: async (...args) => {
      const stored = await defaultPackageMediaIO.store(...args);
      if (++calls === 1) return stored;
      throw new Error('unreachable');
    } };
    const before = new Set(objects.keys());
    vi.spyOn(vstore, 'writePartial').mockRejectedValueOnce(new Error('datastore unavailable'));
    await expect(createSite({ orgId: ORG, name: 'Broken Bakery', from: await fromPackage(zip), media: late })).rejects.toMatchObject({ code: 'site_create_failed' });
    expect(calls).toBe(1);
    expect(await mediaOf(ORG, 'broken-bakery')).toEqual([]);
    // The stored file is gone; only the expired upload staging object remains, as after any upload.
    expect([...objects.keys()].filter(key => !before.has(key) && !key.includes('/uploads/'))).toEqual([]);
    expect(await store().getDoc(paths.site(ORG, 'broken-bakery'))).toBeNull();
    // The id is free again.
    expect((await createSite({ orgId: ORG, name: 'Broken Bakery', from: await fromPackage(zip) })).siteId).toBe('broken-bakery');
  });
});

describe('a new site from another site of the organization', () => {
  it('copies content, media and the look, and strips the source site\'s infrastructure', async () => {
    const { logoUrl, image } = await clientSite();
    const options = parseNewSiteImportOptions(undefined);
    const source = await loadNewSiteSource(ORG, { kind: 'site', site_id: 'client-a' }, options);
    const { siteId, site, started_from } = await createSite({ orgId: ORG, name: 'Client B', domain: undefined, from: { source, options }, actor: 'maker@example.com' });
    expect(siteId).toBe('client-b');

    // The site document is new: no domain, staging address, hosting or script switch of the source.
    const doc = await store().getDoc<Record<string, unknown>>(paths.site(ORG, siteId));
    for (const key of ['domain', 'staging_url', 'hosting_config', 'ai_scripts_enabled']) expect(doc).not.toHaveProperty(key);
    expect(site.language).toBe('nl');

    // Settings: content and look copied, infrastructure stripped.
    const settings = await settingsOf(ORG, siteId) as SiteSettings & Record<string, unknown>;
    expect(settings).toMatchObject({ site_name: 'Client B', language: 'nl', time_zone: 'Europe/Amsterdam', render_version: 14, tagline: 'Since 1990', contact: { email: 'hello@client-a.example' },
      colors: { primary: '#aa0000' }, custom_css: '.brand{letter-spacing:1px}', default_seo_suffix: ' — Client A', cookie_consent: { enabled: true, privacy_policy_url: '/privacy' } });
    expect(settings.fonts).toMatchObject({ smoothing: 'antialiased' });
    expect(settings.fonts.services).toBeUndefined();
    for (const key of ['scripts_head', 'scripts_body_end', 'external_routes', 'extension_public_config', 'sitewide_noindex']) expect(settings).not.toHaveProperty(key);
    expect(settings.cookie_consent).not.toHaveProperty('scripts_optional');
    expect(settings.robots_txt).toBe('User-agent: *\nAllow: /\n');

    // Media: copies in the new site's own library, and every reference rewritten to them.
    const library = await mediaOf(ORG, siteId);
    expect(library.map(media => media.filename).sort()).toEqual(['logo.png', 'team.png']);
    const own = (name: string) => library.find(media => media.filename === name)!.cdn_url;
    expect(own('logo.png')).toMatch(new RegExp(`/api/sites/${siteId}/media/`));
    expect(settings.logo).toBe(own('logo.png'));
    expect(own('logo.png')).not.toBe(logoUrl);
    const home = await vstore.page(ORG, siteId, MAIN_VERSION_ID, 'home') as Page;
    expect(home).toMatchObject({ content_mode: 'html', status: 'published' });
    expect(home.html_content).toContain(own('team.png').replace(/^https:\/\/cms\.example\.com/, ''));
    expect(home.html_content).not.toContain(image.replace(/^https:\/\/cms\.example\.com/, ''));
    expect(home.canonical_url).toBeUndefined();

    // Block pages, records of other content types, the content type, menus, forms without actions, snippets.
    expect(await vstore.page(ORG, siteId, MAIN_VERSION_ID, 'about')).toMatchObject({ content_mode: 'blocks' });
    expect(await vstore.contentType(ORG, siteId, MAIN_VERSION_ID, 'news')).toMatchObject({ route_template: '/news/{slug}' });
    const record = await vstore.page(ORG, siteId, MAIN_VERSION_ID, 'opening') as Page;
    expect(record).toMatchObject({ content_type: 'news', status: 'published' });
    expect(JSON.stringify(record.blocks)).toContain(own('team.png'));
    expect(await vstore.menu(ORG, siteId, MAIN_VERSION_ID, 'primary')).toMatchObject({ items: [{ page_id: 'home' }, { page_id: 'opening' }] });
    expect(await store().getDoc(`${paths.forms(ORG, siteId)}/contact`)).toMatchObject({ name: 'Contact', submit_text: 'Send', actions: [] });
    expect(await store().getDoc(paths.snippet(ORG, siteId, 'notice'))).toMatchObject({ content: 'Closed on Monday', updated_by: 'maker@example.com' });

    // Never copied: app installations, API keys, shares, integrations.
    expect(await store().listDocs(paths.extensionInstallations(ORG, siteId))).toEqual([]);
    expect(await store().listDocs(paths.apiKeys(ORG, siteId))).toEqual([]);
    expect(await store().listDocs(paths.shares(ORG, siteId))).toEqual([]);
    expect(await store().getDoc(paths.integrations(ORG, siteId))).toBeNull();
    const warnings = started_from!.warnings.join('\n');
    expect(warnings).toMatch(/install booking-app on the new site/);
    expect(warnings).toMatch(/copied without its actions/);
    expect(warnings).toMatch(/Custom scripts/);
    expect(warnings).not.toMatch(/HTML page|record; content types/);
    // The source has no header or footer: the new site gets the starter ones.
    expect(started_from!.defaults).toEqual(['header', 'footer', 'footer menu']);
    // The source is unchanged.
    expect((await settingsOf(ORG, 'client-a')).scripts_head).toContain('G-SOURCE');
    expect(await mediaOf(ORG, 'client-a')).toHaveLength(2);
  });

  it('settings classification: content is copied, the look only with the whole look, infrastructure never', () => {
    const { settings, notes } = siteCopySettings({ site_name: 'X', custom_css: 'a{}', tagline: 'T', scripts_head: '<script>', robots_txt: 'x' } as unknown as SiteSettings, 'content');
    expect(settings).toEqual({ tagline: 'T' });
    expect(notes.join(' ')).toMatch(/Custom scripts[\s\S]*robots\.txt/);
    expect(siteCopySettings({ custom_css: 'a{}' } as unknown as SiteSettings, 'full').settings).toEqual({ custom_css: 'a{}' });
  });

  it('refuses a site of another organization, through both doors', async () => {
    await clientSite('foreign', OTHER_ORG);
    await expect(apiNewSiteFrom(ORG, { kind: 'site', site_id: 'foreign' })).rejects.toMatchObject({ status: 404, code: 'site_source_not_found' });
    await expect(apiNewSiteFrom(ORG, { kind: 'site', site_id: 'foreign', version: 'nope' })).rejects.toMatchObject({ code: 'site_source_not_found' });

    // The portal: a site shared in from another organization is not a source either.
    access.owners = { foreign: OTHER_ORG };
    const { POST } = await import('../../pages/api/sites/create');
    const call = (body: unknown) => POST({ request: new Request('https://cms.example.com/api/sites/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), cookies: {}, redirect: () => new Response(null, { status: 302 }) } as unknown as APIContext) as Promise<Response>;
    const refused = await call({ name: 'Copy', from: { site_id: 'foreign' } });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: 'site_source_not_found' });
    expect(await store().listDocs(paths.sites(ORG))).toEqual([]);

    // An own site is copied, and the answer says what the new site started from.
    await clientSite();
    access.owners = { foreign: OTHER_ORG, 'client-a': ORG };
    const created = await call({ name: 'Client C', from: { site_id: 'client-a' }, options: { design: 'styles' } });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'client-c', url: '/app/sites/client-c', started_from: { kind: 'site', source: { site_id: 'client-a' } } });
    expect((await settingsOf(ORG, 'client-c')).colors.primary).toBe('#2563eb');
    expect((await call({ name: 'Bad', from: { site_id: 'client-a', collection_entry: 'x' } })).status).toBe(400);
    expect((await call({ name: 'Bad', from: { site_id: 'client-a' }, options: { only: ['x'] } })).status).toBe(400);
  });

  it('parses the source of a request', async () => {
    await expect(parseNewSiteFrom({ package: { data_base64: 'AAA=' } }, { allowPackage: false })).rejects.toMatchObject({ code: 'site_source_invalid' });
    expect(await parseNewSiteFrom({ package: { data_base64: 'AAEC' } }, { allowPackage: true })).toEqual({ kind: 'package', bytes: new Uint8Array([0, 1, 2]) });
    expect(await parseNewSiteFrom({ site_id: 'client-a', version: 'draft' }, { allowPackage: false })).toEqual({ kind: 'site', site_id: 'client-a', version: 'draft' });
    expect(await parseNewSiteFrom({ collection_entry: 'bakery-1a2b' }, { allowPackage: false })).toEqual({ kind: 'collection_entry', entry_id: 'bakery-1a2b' });
    expect(() => parseNewSiteImportOptions({ design: 'everything' })).toThrow(/design/);
    expect(parseNewSiteImportOptions(undefined)).toEqual({ design: 'full' });
  });
});

describe('POST /api/v1/sites with from', () => {
  const v1 = async (body: unknown) => {
    const { POST } = await import('../../pages/api/v1/sites/index');
    return POST({ request: new Request('https://cms.example.com/api/v1/sites', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify(body) }) } as unknown as APIContext) as Promise<Response>;
  };

  it('starts from a package, a collection entry or an own site, and refuses another organization\'s site', async () => {
    const zip = await templatePackage();
    const fromFile = await v1({ name: 'Api Bakery', from: { package: { data_base64: Buffer.from(zip).toString('base64') } }, options: { design: 'full' } });
    expect(fromFile.status).toBe(201);
    expect(await fromFile.json()).toMatchObject({ id: 'api-bakery', site: { language: 'sv' }, started_from: { kind: 'package', report: { created: { pages: ['home', 'menu'] } } } });

    const { entries } = await addPackageToCollection(ORG, zip, { label: 'maker@example.com' });
    const fromEntry = await v1({ name: 'Entry Bakery', language: 'de', from: { collection_entry: entries[0]!.id } });
    expect(fromEntry.status).toBe(201);
    expect(await fromEntry.json()).toMatchObject({ site: { language: 'de' }, started_from: { kind: 'collection_entry' } });

    const fromSite = await v1({ name: 'Bakery Copy', from: { site_id: 'api-bakery' } });
    expect(fromSite.status).toBe(201);
    expect(await vstore.page(ORG, 'bakery-copy', MAIN_VERSION_ID, 'menu')).toBeTruthy();
    expect((await mediaOf(ORG, 'bakery-copy'))[0]).toMatchObject({ demo: true });

    await clientSite('foreign', OTHER_ORG);
    const refused = await v1({ name: 'Stolen', from: { site_id: 'foreign' } });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: 'site_source_not_found' });
    expect((await v1({ name: 'Opts', options: { design: 'full' } })).status).toBe(400);
    expect((await v1({ name: 'Bad', from: { site_id: 'api-bakery' }, options: { design: 'all' } })).status).toBe(400);
    expect(await store().getDoc(paths.site(ORG, 'stolen'))).toBeNull();
  });
});
