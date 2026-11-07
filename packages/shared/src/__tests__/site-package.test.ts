import { describe, expect, it } from 'vitest';
import {
  blockStyleRefs, canonicalJson, freeId, packageMediaRefs, planPackageImport, portableBlockType, replaceStrings,
  rewriteBlockReferences, signSitePackage, sitePackageDigest, sitePackageErrors, verifySitePackage,
  type Block, type PackageImportTarget, type SitePackage, type SiteStyle,
} from '../index.js';

const sha = (char: string) => char.repeat(64);
const lead: SiteStyle = { id: 'lead', name: 'Lead', role: 'lead', targets: ['text'], base: { size: 'lg' } };
const hero: SiteStyle = { id: 'hero', name: 'Hero', targets: ['heading'], base: { font: 'display', weight: 800 } };
const unused: SiteStyle = { id: 'note', name: 'Note', targets: ['text'], base: { size: 'sm' } };
const h1: SiteStyle = { id: 'h1', name: 'Heading 1', role: 'h1', targets: [], base: { weight: 900 } };

function pkg(overrides: Partial<SitePackage> = {}, contents: SitePackage['contents'] = {}): SitePackage {
  const blocks: Block[] = [
    { id: 'a', type: 'core/rich_heading', data: { html: 'Welcome', style_id: 'hero' } },
    { id: 'b', type: 'core/prose', data: { html: '<p class="s-lead">Intro</p><img src="typeroll-media:photo">' } },
    { id: 'c', type: 'acme-card', data: { part_styles: { title: 'hero' }, image: 'typeroll-media:photo' } },
    { id: 'd', type: 'core/global_block', data: { global_block_id: 'cta' } },
  ];
  return {
    format: 'typeroll-package', format_version: 1, kind: 'collection', id: 'acme-sections', name: 'Acme sections', version: '1.0.0',
    created_at: '2026-11-07T10:00:00Z', author: { name: 'Acme Studio' }, licence: { name: 'Commercial' },
    contents: {
      block_templates: [{ id: 'hero', name: 'Hero', kind: 'section', blocks }],
      global_blocks: [{ id: 'cta', name: 'Call to action', kind: 'free', blocks: [{ id: 'e', type: 'core/button', data: { label: 'Book', style_id: 'button' } }] }],
      block_types: [{ id: 'acme-card', name: 'acme-card', label: 'Card', template: '<div>{{title}}</div>' } as never],
      styles: [lead, hero, unused, h1],
      design: { colors: { primary: '#0a6' }, fonts: { heading: 'Playfair Display', body: 'Inter' }, font_services: [{ provider: 'adobe', families: ['proxima-nova'] }] },
      ...contents,
    },
    media: [{ id: 'photo', path: `media/${sha('a')}.jpg`, sha256: sha('a'), bytes: 1200, content_type: 'image/jpeg', filename: 'photo.jpg', demo: true }],
    fonts: [{ family: 'Acme Sans', weight: 400, style: 'normal', path: `fonts/${sha('b')}.woff2`, sha256: sha('b'), bytes: 900, redistributable: true }],
    integrity: { algorithm: 'sha256', files: { [`media/${sha('a')}.jpg`]: sha('a'), [`fonts/${sha('b')}.woff2`]: sha('b') } },
    ...overrides,
  };
}

const emptyTarget: PackageImportTarget = { styles: [], blockTypes: [], blockTemplateIds: [], pageTemplateIds: [], globalBlockIds: [], menuIds: [] };

describe('sitePackageErrors', () => {
  it('accepts a complete package', () => {
    expect(sitePackageErrors(pkg())).toEqual([]);
  });

  it('refuses other formats, broken trees, unknown media and files outside integrity', () => {
    expect(sitePackageErrors({ format: 'zip' })[0]).toMatch(/format must be/);
    const broken = pkg({ media: [], integrity: { algorithm: 'sha256', files: {} } });
    expect(sitePackageErrors(broken)).toContain('content refers to media "photo", which the package does not contain');
    const tree = pkg({}, { block_templates: [{ id: 'x', name: 'X', blocks: 'nope' as never }] });
    expect(sitePackageErrors(tree).some(error => error.startsWith('block_templates.x:'))).toBe(true);
    const missing = pkg({ integrity: { algorithm: 'sha256', files: {} } });
    expect(sitePackageErrors(missing)).toContain('media photo: missing from integrity');
    const core = pkg({}, { block_types: [{ id: 'core/prose' } as never] });
    expect(sitePackageErrors(core)).toContain('contents.block_types may hold only site block types (not core/ or template/)');
    const font = pkg({ fonts: [{ ...pkg().fonts![0], redistributable: false as never }] });
    expect(sitePackageErrors(font)[0]).toMatch(/may be passed on/);
  });

  it('refuses unsafe paths and a newer format', () => {
    expect(sitePackageErrors(pkg({ format_version: 2 as never }))[0]).toMatch(/not supported/);
    const media = { ...pkg().media[0], path: '../etc/passwd' };
    expect(sitePackageErrors(pkg({ media: [media] }))).toContain('media photo: path must be media/<sha256>.<ext>');
  });
});

describe('references', () => {
  it('finds styles, including rich-text classes and part styles', () => {
    expect(blockStyleRefs(pkg().contents.block_templates![0].blocks).sort()).toEqual(['hero', 'lead']);
    expect(packageMediaRefs(pkg().contents)).toEqual(['photo']);
  });

  it('rewrites style, block type, global block, page and menu ids', () => {
    const blocks: Block[] = [{ id: 'x', type: 'acme-card', data: {
      style_id: 'hero', eyebrow_style_id: 'lead', part_styles: { title: 'hero' }, html: '<p class="big s-lead">x</p>',
      global_block_id: 'cta', link: { page_id: 'about' }, menu: 'main', page_ids: ['about'],
    }, children: [{ id: 'y', type: 'core/nav', data: { menu: 'location:primary' } }] }];
    const [out] = rewriteBlockReferences(blocks, {
      styles: new Map([['hero', 'hero-2'], ['lead', 'lead-2']]), blockTypes: new Map([['acme-card', 'acme-card-2']]),
      globalBlocks: new Map([['cta', 'cta-2']]), pages: new Map([['about', 'p_about']]), menus: new Map([['main', 'main-2']]),
    });
    expect(out.type).toBe('acme-card-2');
    expect(out.data).toEqual({ style_id: 'hero-2', eyebrow_style_id: 'lead-2', part_styles: { title: 'hero-2' }, html: '<p class="big s-lead-2">x</p>', global_block_id: 'cta-2', link: { page_id: 'p_about' }, menu: 'main-2', page_ids: ['p_about'] });
    expect(out.children![0].data.menu).toBe('location:primary');
    expect(blocks[0].data.style_id).toBe('hero');
  });

  it('replaces media addresses with package tokens and back', () => {
    const map = new Map([['https://portal/api/sites/s1/media/m1/content', 'typeroll-media:m1']]);
    expect(replaceStrings({ a: ['<img src="https://portal/api/sites/s1/media/m1/content">'] }, map)).toEqual({ a: ['<img src="typeroll-media:m1">'] });
  });

  it('names app blocks by their app, not the installation', () => {
    expect(portableBlockType('extension--inst42--map', { inst42: 'com.example.maps' })).toBe('app:com.example.maps/map');
    expect(portableBlockType('acme-card', {})).toBe('acme-card');
  });
});

describe('planPackageImport', () => {
  it('creates the styles the content uses, not the others, in content mode', () => {
    const plan = planPackageImport(pkg(), emptyTarget, { design: 'content' });
    expect(plan.styles.map(s => [s.action, s.from, s.to])).toEqual([['create', 'lead', 'lead'], ['create', 'hero', 'hero']]);
    expect(plan.block_types).toEqual([{ action: 'create', from: 'acme-card', to: 'acme-card' }]);
    expect(plan.global_blocks).toEqual([{ action: 'create', from: 'cta', to: 'cta', name: 'Call to action', kind: 'free' }]);
    expect(plan.design).toBeNull();
    expect(plan.fonts).toEqual([]);
    expect(plan.media).toEqual(['photo']);
    expect(plan.warnings).toContain('The content uses the style "button", which neither the package nor the site has; those blocks keep their default look.');
  });

  it('reuses identical styles and creates differing ones under a new id, never mapping them', () => {
    const target = { ...emptyTarget, styles: [{ ...lead, name: 'Ingress' }, { ...hero, base: { weight: 700 } }, { id: 'hero-2', name: 'Taken', targets: [], base: {} }] as SiteStyle[] };
    const plan = planPackageImport(pkg(), target, { design: 'content' });
    expect(plan.styles.map(s => [s.action, s.from, s.to, s.name])).toEqual([['reuse', 'lead', 'lead', 'Ingress'], ['rename', 'hero', 'hero-3', 'Hero (imported)']]);
    expect([...plan.maps.styles]).toEqual([['hero', 'hero-3']]);
  });

  it('drops a standard role from a renamed copy, since a site has one style per role', () => {
    const target = { ...emptyTarget, styles: [{ ...lead, base: { size: 'xl' } }] as SiteStyle[] };
    const created = planPackageImport(pkg(), target, { design: 'content' }).styles.find(s => s.from === 'lead')!;
    expect(created).toMatchObject({ action: 'rename', to: 'lead-2' });
    expect(created.style.role).toBeUndefined();
  });

  it('adds the other class styles in styles mode and element styles, tokens and fonts in full mode', () => {
    expect(planPackageImport(pkg(), emptyTarget, { design: 'styles' }).styles.map(s => s.from)).toEqual(['lead', 'hero', 'note']);
    const target = { ...emptyTarget, styles: [{ ...h1, id: 'site-h1', base: { weight: 600 } }] as SiteStyle[] };
    const full = planPackageImport(pkg(), target, { design: 'full', fonts: true });
    expect(full.styles.find(s => s.from === 'h1')).toMatchObject({ action: 'replace', to: 'site-h1' });
    expect(full.design?.colors).toEqual({ primary: '#0a6' });
    expect(full.fonts.map(font => font.family)).toEqual(['Acme Sans']);
    expect(full.warnings.some(w => w.includes('add your own kit'))).toBe(true);
    const noFonts = planPackageImport(pkg(), emptyTarget, { design: 'full', fonts: false });
    expect(noFonts.fonts).toEqual([]);
    expect(noFonts.design?.fonts).toBeUndefined();
  });

  it('renames block types, templates and global blocks that collide', () => {
    const target = { ...emptyTarget, blockTypes: [{ id: 'acme-card', template: '<p>other</p>' }], blockTemplateIds: ['hero'], globalBlockIds: ['cta'] };
    const plan = planPackageImport(pkg(), target, { design: 'content' });
    expect(plan.block_types[0]).toEqual({ action: 'rename', from: 'acme-card', to: 'acme-card-2' });
    expect(plan.block_templates[0]).toMatchObject({ action: 'rename', to: 'hero-2' });
    expect(plan.global_blocks[0]).toMatchObject({ action: 'rename', to: 'cta-2' });
    const same = planPackageImport(pkg(), { ...emptyTarget, blockTypes: [{ ...pkg().contents.block_types![0], updated_at: 'x' }] }, { design: 'content' });
    expect(same.block_types[0].action).toBe('reuse');
  });

  it('imports only the chosen entries and what they need', () => {
    const extra = pkg({}, { block_templates: [...pkg().contents.block_templates!, { id: 'plain', name: 'Plain', blocks: [{ id: 'p', type: 'core/prose', data: { html: '<p>x</p>' } }] }] });
    const plan = planPackageImport(extra, emptyTarget, { design: 'content', only: ['block_templates.plain'] });
    expect(plan.block_templates.map(t => t.from)).toEqual(['plain']);
    expect(plan.styles).toEqual([]);
    expect(plan.global_blocks).toEqual([]);
    expect(plan.block_types).toEqual([]);
  });

  it('reconnects app blocks to the installed app or warns', () => {
    const app = pkg({}, { block_templates: [{ id: 'map', name: 'Map', blocks: [{ id: 'm', type: 'app:com.example.maps/map', data: {} }] }] });
    expect([...planPackageImport(app, { ...emptyTarget, extensions: { 'com.example.maps': 'inst9' } }, { design: 'content' }).maps.blockTypes]).toEqual([['app:com.example.maps/map', 'extension--inst9--map']]);
    expect(planPackageImport(app, emptyTarget, { design: 'content' }).warnings[0]).toMatch(/com\.example\.maps/);
  });

  it('imports a whole site with its pages, menus and headers', () => {
    const site = pkg({ kind: 'site' }, {
      global_blocks: [{ id: 'header', name: 'Header', kind: 'header', blocks: [] }, { id: 'cta', name: 'CTA', kind: 'free', blocks: [] }],
      pages: [{ id: 'home', title: 'Home', slug: '' }, { id: 'about', title: 'About', slug: 'about' }],
      menus: [{ id: 'main', name: 'Main', locations: ['primary'], items: [{ id: 'i', type: 'page', page_id: 'about' }] }],
    });
    const plan = planPackageImport(site, { ...emptyTarget, pageIds: ['home'], menuLocations: ['primary'] }, { design: 'full' });
    expect(plan.pages).toEqual([{ action: 'rename', from: 'home', to: 'home-2' }, { action: 'create', from: 'about', to: 'about' }]);
    expect(plan.global_blocks.map(g => g.kind)).toEqual(['header', 'free']);
    expect(plan.menus[0]).toMatchObject({ action: 'create', locations: [] });
  });
});

describe('signatures', () => {
  it('verifies a signature from a trusted key and rejects changes', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const private_jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
    const public_jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    const signed = await signSitePackage(pkg(), { key_id: 'typeroll-2026', private_jwk });
    const trusted = [{ key_id: 'typeroll-2026', publisher: 'Typeroll', public_jwk }];
    expect(await verifySitePackage(signed, trusted)).toEqual({ status: 'verified', publisher: 'Typeroll' });
    expect(await verifySitePackage({ ...signed, name: 'Changed' }, trusted)).toEqual({ status: 'invalid' });
    expect(await verifySitePackage(signed, [])).toEqual({ status: 'unknown_key' });
    expect(await verifySitePackage(pkg(), trusted)).toEqual({ status: 'unsigned' });
  });

  it('digests the canonical manifest', async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    const one = await sitePackageDigest(pkg());
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(await sitePackageDigest({ ...pkg(), signature: { key_id: 'k', algorithm: 'Ed25519', value: 'x' } })).toBe(one);
  });

  it('finds free ids', () => {
    expect(freeId('hero', new Set(['hero', 'hero-2']))).toBe('hero-3');
    expect(freeId('x', new Set())).toBe('x');
  });
});
