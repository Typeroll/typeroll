/**
 * Typeroll packages (`.typeroll`): templates, sections, page templates,
 * global blocks, block types, styles, design tokens, fonts, menus, site field
 * definitions and whole sites, as one portable file.
 *
 * A package belongs to no organization: it carries no organization or site
 * ids, and its media and fonts travel inside it. Anyone can import it into
 * their own site or organization collection, for example a template pack
 * bought from someone else.
 *
 * The file is a zip:
 *   typeroll.json            the manifest (`SitePackage`)
 *   media/<sha256>.<ext>     media files, referenced in content as `typeroll-media:<id>`
 *   fonts/<sha256>.woff2     font files the author may redistribute
 *
 * Every file's sha256 is in `integrity`; the manifest digest may be signed
 * (Ed25519). Import validates everything again, like any other input.
 *
 * Styles are never mapped to "nearest" styles on import: the styles the
 * content uses are created on the site, keeping their ids where they are
 * free, so imported style choices stay and can be changed site-wide.
 */
import type { Block, BlockType, PageTemplate } from './types.js';
import type { Menu } from './menus.js';
import type { SiteFieldGroup } from './site-fields.js';
import type { SiteStyle } from './site-styles.js';
import { STYLE_ELEMENT_ROLES, validateSiteStyle } from './site-styles.js';
import { validateMenu } from './menus.js';
import { validateSiteFieldGroups } from './site-fields.js';
import { blockTreeError } from './block-tree-validation.js';
import { FAMILY_PATTERN } from './font-plan.js';

export const SITE_PACKAGE_FORMAT = 'typeroll-package';
export const SITE_PACKAGE_FORMAT_VERSION = 1;
export const SITE_PACKAGE_EXTENSION = '.typeroll';
export const SITE_PACKAGE_MANIFEST = 'typeroll.json';
export const SITE_PACKAGE_MEDIA_TYPE = 'application/vnd.typeroll.package+zip';

export const PACKAGE_LIMITS = {
  zip_bytes: 200 * 1024 * 1024,
  uncompressed_bytes: 400 * 1024 * 1024,
  manifest_bytes: 20 * 1024 * 1024,
  entries: 5000,
  media: 2000,
  media_bytes: 50 * 1024 * 1024,
  fonts: 60,
  block_templates: 500,
  page_templates: 100,
  global_blocks: 200,
  block_types: 200,
  styles: 300,
  menus: 50,
  pages: 2000,
} as const;

/**
 * `collection`: entries to add to a site or organization collection.
 * `site`: a whole site, to start a new site from.
 * `clipboard`: blocks copied from a page, to paste into another.
 */
export type SitePackageKind = 'collection' | 'site' | 'clipboard';

export interface PackageMedia {
  /** Package-local id; content refers to it as `typeroll-media:<id>`. */
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  content_type: string;
  filename: string;
  alt_text?: string;
  title?: string;
  width?: number;
  height?: number;
  /** Demo content: listed for replacement before the site publishes it. */
  demo?: boolean;
}

export interface PackageFont {
  family: string;
  weight: number | [number, number];
  style: 'normal' | 'italic';
  path: string;
  sha256: string;
  bytes: number;
  category?: 'sans' | 'serif';
  /** The author confirmed the licence allows passing the file on. */
  redistributable: true;
  licence_note?: string;
}

export interface PackageBlockTemplate {
  id: string;
  name: string;
  description?: string;
  /** `section`: a full-width page section; `block`: any other block group. */
  kind?: 'block' | 'section';
  category?: string;
  blocks: Block[];
  /** Media id of a preview image. */
  preview?: string;
}

export interface PackageGlobalBlock {
  id: string;
  name: string;
  kind: 'header' | 'footer' | 'free';
  blocks: Block[];
}

export type PackagePageTemplate = Pick<PageTemplate, 'id' | 'name' | 'label' | 'icon' | 'applies_to' | 'blocks'>;

/** A site block type, as defined on its site (core and template types are never packaged). */
export type PackageBlockType = Omit<BlockType, 'created_at' | 'updated_at'> & Record<string, unknown>;

export interface PackagePage {
  id: string;
  title: string;
  slug: string;
  /** Explicit address (`Page.path`), when the page has one. */
  path?: string;
  parent_id?: string | null;
  status?: 'published' | 'draft' | 'unlisted';
  content_type?: string;
  template_id?: string;
  language?: string;
  blocks?: Block[];
  fields?: Record<string, unknown>;
  seo?: Record<string, unknown>;
  order?: number;
}

/** Design tokens and font roles (`SiteSettings` keys). */
export interface PackageDesign {
  colors?: Record<string, string>;
  typography?: Record<string, unknown>;
  design_scales?: Record<string, unknown>;
  content_widths?: Record<string, unknown>;
  fonts?: { heading?: string; body?: string; mono?: string; display?: string; accent?: string; size_base?: number; load?: Record<string, unknown> };
  /** Font services the author used; a buyer adds their own kit or stylesheet. */
  font_services?: Array<{ provider: 'adobe' | 'bunny' | 'fontshare'; families: string[] }>;
}

export interface SitePackage {
  format: typeof SITE_PACKAGE_FORMAT;
  format_version: typeof SITE_PACKAGE_FORMAT_VERSION;
  kind: SitePackageKind;
  /** Stable slug of the package, e.g. `acme-restaurant-sections`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; url?: string };
  licence?: { name: string; url?: string };
  /** Language of the sample text; several when the package carries translations. */
  languages?: string[];
  created_at: string;
  generator?: { core_version?: string };
  /** The render version the content was made for. */
  render_version?: number;
  contents: {
    block_templates?: PackageBlockTemplate[];
    page_templates?: PackagePageTemplate[];
    global_blocks?: PackageGlobalBlock[];
    block_types?: PackageBlockType[];
    styles?: SiteStyle[];
    design?: PackageDesign;
    menus?: Menu[];
    site_fields?: SiteFieldGroup[];
    /** Site packages: the values of the site fields (`SiteFields.values`). */
    site_field_values?: Record<string, unknown>;
    pages?: PackagePage[];
    /** Clipboard packages: the copied blocks. */
    blocks?: Block[];
  };
  media: PackageMedia[];
  fonts?: PackageFont[];
  /** sha256 of every file in the zip except the manifest. */
  integrity: { algorithm: 'sha256'; files: Record<string, string> };
  signature?: { key_id: string; algorithm: 'Ed25519'; value: string };
}

// ── Media references ──────────────────────────────────────────────────────

export const PACKAGE_MEDIA_SCHEME = 'typeroll-media:';
const MEDIA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MEDIA_TOKEN = /typeroll-media:([a-z0-9][a-z0-9_-]{0,63})/g;
export const packageMediaUrl = (id: string) => `${PACKAGE_MEDIA_SCHEME}${id}`;

/** Package media ids referenced anywhere in a value. */
export function packageMediaRefs(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return [...new Set(Array.from(text.matchAll(MEDIA_TOKEN), match => match[1]))];
}

/** Replace exact strings throughout a JSON value (media URLs ↔ package tokens). */
export function replaceStrings<T>(value: T, replacements: ReadonlyMap<string, string>): T {
  if (!replacements.size) return value;
  const keys = [...replacements.keys()].sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(keys.join('|'), 'g');
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return input.replace(pattern, match => replacements.get(match) ?? match);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, inner]) => [key, walk(inner)]));
    return input;
  };
  return walk(value) as T;
}

// ── Block references ──────────────────────────────────────────────────────

export interface BlockReferenceMaps {
  styles?: ReadonlyMap<string, string>;
  blockTypes?: ReadonlyMap<string, string>;
  globalBlocks?: ReadonlyMap<string, string>;
  pages?: ReadonlyMap<string, string>;
  menus?: ReadonlyMap<string, string>;
  forms?: ReadonlyMap<string, string>;
}

const STYLE_KEY = /(?:^|_)style_id$/;
const CLASS_ATTR = /\bclass=(["'])([^"']*)\1/g;

/** The style ids a block tree chooses: style fields, part styles and `s-<id>` classes in rich text. */
export function blockStyleRefs(blocks: readonly Block[] | undefined): string[] {
  const found = new Set<string>();
  const scanText = (text: string) => {
    for (const match of text.matchAll(CLASS_ATTR)) for (const name of match[2].split(/\s+/)) if (name.startsWith('s-') && name.length > 2) found.add(name.slice(2));
  };
  const scan = (value: unknown, key = '') => {
    if (typeof value === 'string') { if (STYLE_KEY.test(key) && value) found.add(value); else if (value.includes('class=')) scanText(value); }
    else if (Array.isArray(value)) value.forEach(item => scan(item));
    else if (value && typeof value === 'object') for (const [inner, child] of Object.entries(value)) {
      if (inner === 'part_styles' && child && typeof child === 'object') { for (const id of Object.values(child)) if (typeof id === 'string' && id) found.add(id); }
      else scan(child, inner);
    }
  };
  walkBlocks(blocks, block => { scan(block.data); scan(block.responsive); });
  return [...found];
}

/** Every block type a block tree uses. */
export function blockTypeRefs(blocks: readonly Block[] | undefined): string[] {
  const found = new Set<string>();
  walkBlocks(blocks, block => { found.add(block.type); });
  return [...found];
}

function walkBlocks(blocks: readonly Block[] | undefined, visit: (block: Block) => void, depth = 0) {
  if (!Array.isArray(blocks) || depth > 64) return;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    visit(block);
    walkBlocks(block.children, visit, depth + 1);
    for (const slot of block.slots ?? []) walkBlocks(slot, visit, depth + 1);
  }
}

/**
 * Rewrite a block tree's references to styles, block types, global blocks,
 * pages, menus and forms through the given id maps. Ids not in a map stay.
 */
export function rewriteBlockReferences(blocks: readonly Block[], maps: BlockReferenceMaps): Block[] {
  const style = (id: string) => maps.styles?.get(id) ?? id;
  const rewriteClasses = (text: string) => !maps.styles?.size || !text.includes('class=') ? text
    : text.replace(CLASS_ATTR, (_, quote, names: string) => `class=${quote}${names.split(/(\s+)/).map(name => name.startsWith('s-') && maps.styles!.has(name.slice(2)) ? `s-${maps.styles!.get(name.slice(2))}` : name).join('')}${quote}`);
  const rewrite = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (STYLE_KEY.test(key)) return style(value);
      if (key === 'page_id' || key === 'parent_page_id') return maps.pages?.get(value) ?? value;
      if (key === 'global_block_id') return maps.globalBlocks?.get(value) ?? value;
      if (key === 'form_id') return maps.forms?.get(value) ?? value;
      if (key === 'menu' && !value.startsWith('location:')) return maps.menus?.get(value) ?? value;
      return rewriteClasses(value);
    }
    if (Array.isArray(value)) return key === 'page_ids' ? value.map(id => typeof id === 'string' ? maps.pages?.get(id) ?? id : id) : value.map(item => rewrite(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([inner, child]) => [inner,
        inner === 'part_styles' && child && typeof child === 'object' && !Array.isArray(child)
          ? Object.fromEntries(Object.entries(child).map(([part, id]) => [part, typeof id === 'string' ? style(id) : id]))
          : rewrite(child, inner)]));
    }
    return value;
  };
  const copy = (block: Block): Block => {
    const next: Block = { ...block, type: maps.blockTypes?.get(block.type) ?? block.type, data: rewrite(block.data ?? {}) as Record<string, unknown> };
    if (block.responsive) next.responsive = rewrite(block.responsive) as Block['responsive'];
    if (block.children) next.children = block.children.map(copy);
    if (block.slots) next.slots = block.slots.map(slot => slot.map(copy));
    return next;
  };
  return blocks.map(copy);
}

/** Every block tree in a package, with where it is. */
export function packageBlockTrees(pkg: Pick<SitePackage, 'contents'>): Array<{ where: string; blocks: Block[] }> {
  const c = pkg.contents;
  return [
    ...(c.block_templates ?? []).map(t => ({ where: `block_templates.${t.id}`, blocks: t.blocks })),
    ...(c.page_templates ?? []).map(t => ({ where: `page_templates.${t.id}`, blocks: t.blocks ?? [] })),
    ...(c.global_blocks ?? []).map(g => ({ where: `global_blocks.${g.id}`, blocks: g.blocks })),
    ...(c.pages ?? []).map(p => ({ where: `pages.${p.id}`, blocks: p.blocks ?? [] })),
    ...(c.blocks ? [{ where: 'blocks', blocks: c.blocks }] : []),
  ];
}

// ── Validation ────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STYLE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const FILE_PATH = /^(media|fonts)\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Check a package manifest. Returns the errors; an empty list means it can be imported. */
export function sitePackageErrors(input: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(input)) return ['The package manifest must be a JSON object'];
  const p = input as Partial<SitePackage> & Record<string, unknown>;
  if (p.format !== SITE_PACKAGE_FORMAT) errors.push(`format must be "${SITE_PACKAGE_FORMAT}"`);
  if (p.format_version !== SITE_PACKAGE_FORMAT_VERSION) errors.push(`format_version ${String(p.format_version)} is not supported (this Core reads ${SITE_PACKAGE_FORMAT_VERSION})`);
  if (!['collection', 'site', 'clipboard'].includes(p.kind as string)) errors.push('kind must be collection, site or clipboard');
  if (typeof p.id !== 'string' || !SLUG.test(p.id)) errors.push('id must be a slug (lowercase letters, digits, - and _)');
  if (!text(p.name, 120)) errors.push('name is required (at most 120 characters)');
  if (!text(p.version, 32)) errors.push('version is required (at most 32 characters)');
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 2000)) errors.push('description must be at most 2000 characters');
  if (p.author !== undefined && (!isObject(p.author) || !text(p.author.name, 120))) errors.push('author must be { name, url? }');
  if (p.licence !== undefined && (!isObject(p.licence) || !text(p.licence.name, 120))) errors.push('licence must be { name, url? }');
  if (typeof p.created_at !== 'string' || Number.isNaN(Date.parse(p.created_at))) errors.push('created_at must be a date');
  if (!isObject(p.contents)) { errors.push('contents must be an object'); return errors; }
  const c = p.contents as SitePackage['contents'];
  const limit = (key: keyof typeof PACKAGE_LIMITS, list: unknown[] | undefined, label: string) => {
    if (list !== undefined && !Array.isArray(list)) errors.push(`${label} must be a list`);
    else if (list && list.length > PACKAGE_LIMITS[key]) errors.push(`${label} has more than ${PACKAGE_LIMITS[key]} entries`);
  };
  limit('block_templates', c.block_templates, 'contents.block_templates');
  limit('page_templates', c.page_templates, 'contents.page_templates');
  limit('global_blocks', c.global_blocks, 'contents.global_blocks');
  limit('block_types', c.block_types, 'contents.block_types');
  limit('styles', c.styles, 'contents.styles');
  limit('menus', c.menus, 'contents.menus');
  limit('pages', c.pages, 'contents.pages');
  limit('media', p.media, 'media');
  limit('fonts', p.fonts, 'fonts');
  if (errors.length) return errors;

  const unique = (list: Array<{ id: string }> | undefined, label: string) => {
    const seen = new Set<string>();
    for (const entry of list ?? []) {
      if (!isObject(entry) || typeof entry.id !== 'string') { errors.push(`${label} entries need an id`); continue; }
      if (seen.has(entry.id)) errors.push(`${label}: id "${entry.id}" is used twice`);
      seen.add(entry.id);
    }
  };
  unique(c.block_templates, 'contents.block_templates');
  unique(c.page_templates, 'contents.page_templates');
  unique(c.global_blocks, 'contents.global_blocks');
  unique(c.styles, 'contents.styles');
  unique(c.menus, 'contents.menus');
  unique(c.pages, 'contents.pages');
  for (const t of c.block_templates ?? []) {
    if (!SLUG.test(t.id) || !text(t.name, 120)) errors.push(`block template ${t.id}: needs a slug id and a name`);
    if (t.kind !== undefined && t.kind !== 'block' && t.kind !== 'section') errors.push(`block template ${t.id}: kind must be block or section`);
  }
  for (const g of c.global_blocks ?? []) if (!['header', 'footer', 'free'].includes(g.kind)) errors.push(`global block ${g.id}: kind must be header, footer or free`);
  for (const tree of packageBlockTrees({ contents: c })) {
    const problem = blockTreeError(tree.blocks);
    if (problem) errors.push(`${tree.where}: ${problem}`);
  }
  for (const style of c.styles ?? []) {
    if (!STYLE_ID.test(style.id)) errors.push(`style ${style.id}: invalid id`);
    const checked = validateSiteStyle(style);
    if (checked.errors.length) errors.push(...checked.errors.map(error => `style ${style.id}: ${error}`));
  }
  for (const menu of c.menus ?? []) for (const error of validateMenu(menu).errors) errors.push(`menu ${menu.id}: ${error.path} ${error.message}`);
  if (c.site_fields) for (const error of validateSiteFieldGroups(c.site_fields).errors) errors.push(`site_fields: ${error.path} ${error.message}`);
  for (const type of c.block_types ?? []) {
    if (!isObject(type) || typeof type.id !== 'string' || /^(core|template)\//.test(type.id)) errors.push('contents.block_types may hold only site block types (not core/ or template/)');
  }
  for (const page of c.pages ?? []) if (!text(page.title, 500) || typeof page.slug !== 'string') errors.push(`page ${page.id}: needs a title and a slug`);
  if (c.design?.fonts) for (const [role, family] of Object.entries(c.design.fonts)) {
    if (['heading', 'body', 'mono', 'display', 'accent'].includes(role) && family !== undefined && (typeof family !== 'string' || !FAMILY_PATTERN.test(family))) errors.push(`design.fonts.${role} must be a family name`);
  }

  const files = isObject(p.integrity) && isObject(p.integrity.files) ? p.integrity.files as Record<string, string> : null;
  if (!files || p.integrity?.algorithm !== 'sha256') errors.push('integrity must list the sha256 of every file');
  const mediaIds = new Set<string>();
  for (const media of p.media ?? []) {
    if (!isObject(media) || typeof media.id !== 'string' || !MEDIA_ID.test(media.id)) { errors.push('media entries need a slug id'); continue; }
    if (mediaIds.has(media.id)) errors.push(`media id "${media.id}" is used twice`);
    mediaIds.add(media.id);
    if (!FILE_PATH.test(media.path) || !media.path.startsWith('media/')) errors.push(`media ${media.id}: path must be media/<sha256>.<ext>`);
    if (!SHA256.test(media.sha256) || !media.path.includes(media.sha256)) errors.push(`media ${media.id}: sha256 must match its path`);
    if (!Number.isInteger(media.bytes) || media.bytes <= 0 || media.bytes > PACKAGE_LIMITS.media_bytes) errors.push(`media ${media.id}: bytes must be 1–${PACKAGE_LIMITS.media_bytes}`);
    if (typeof media.content_type !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(media.content_type)) errors.push(`media ${media.id}: content_type is required`);
    if (!text(media.filename, 200)) errors.push(`media ${media.id}: filename is required`);
    if (files && files[media.path] !== media.sha256) errors.push(`media ${media.id}: missing from integrity`);
  }
  for (const font of p.fonts ?? []) {
    if (!FAMILY_PATTERN.test(font.family) || font.redistributable !== true) errors.push(`font ${font.family}: needs a family name and the author's confirmation that it may be passed on`);
    if (!FILE_PATH.test(font.path) || !font.path.startsWith('fonts/') || !font.path.endsWith('.woff2') || !font.path.includes(font.sha256)) errors.push(`font ${font.family}: path must be fonts/<sha256>.woff2`);
    if (files && files[font.path] !== font.sha256) errors.push(`font ${font.family}: missing from integrity`);
  }
  for (const id of packageMediaRefs(c)) if (!mediaIds.has(id)) errors.push(`content refers to media "${id}", which the package does not contain`);
  if (files) for (const [path, sha] of Object.entries(files)) if (!FILE_PATH.test(path) || !SHA256.test(sha)) errors.push(`integrity: invalid entry ${path}`);
  if (p.signature !== undefined && (!isObject(p.signature) || p.signature.algorithm !== 'Ed25519' || typeof p.signature.key_id !== 'string' || typeof p.signature.value !== 'string')) errors.push('signature must be { key_id, algorithm: "Ed25519", value }');
  return errors;
}

// ── Digest and signature ──────────────────────────────────────────────────

/** JSON with sorted keys and no whitespace, so the same manifest always has the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

/** sha256 of a file's bytes, as hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** The digest a signature covers: the canonical manifest without its signature. Its integrity list covers every file. */
export async function sitePackageDigest(pkg: SitePackage): Promise<string> {
  const { signature: _signature, ...unsigned } = pkg;
  return sha256Hex(new TextEncoder().encode(canonicalJson(unsigned)));
}

/** Sign a package with an Ed25519 private key (JWK). */
export async function signSitePackage(pkg: SitePackage, key: { key_id: string; private_jwk: JsonWebKey }): Promise<SitePackage> {
  const privateKey = await crypto.subtle.importKey('jwk', key.private_jwk, { name: 'Ed25519' }, false, ['sign']);
  const digest = await sitePackageDigest(pkg);
  const value = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(digest));
  return { ...pkg, signature: { key_id: key.key_id, algorithm: 'Ed25519', value: base64url(value) } };
}

export type PackageSignatureStatus = 'verified' | 'unsigned' | 'unknown_key' | 'invalid';
export interface TrustedPackageKey { key_id: string; publisher: string; public_jwk: JsonWebKey }

/**
 * Whether a trusted publisher signed the package. An unsigned package can
 * still be imported; the import shows who it claims to come from as unverified.
 */
export async function verifySitePackage(pkg: SitePackage, trusted: readonly TrustedPackageKey[]): Promise<{ status: PackageSignatureStatus; publisher?: string }> {
  if (!pkg.signature) return { status: 'unsigned' };
  const key = trusted.find(candidate => candidate.key_id === pkg.signature!.key_id);
  if (!key) return { status: 'unknown_key' };
  try {
    const publicKey = await crypto.subtle.importKey('jwk', key.public_jwk, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, fromBase64url(pkg.signature.value) as BufferSource, new TextEncoder().encode(await sitePackageDigest(pkg)));
    return ok ? { status: 'verified', publisher: key.publisher } : { status: 'invalid' };
  } catch { return { status: 'invalid' }; }
}

// ── Import planning ───────────────────────────────────────────────────────

/**
 * How much of a package's look an import takes:
 * - `content`: the blocks, plus every style they use (created, not mapped).
 * - `styles`: also the package's other class styles.
 * - `full`: also the element styles (body, h1–h6, link), colours, typography,
 *   scales, content widths and font roles. The default for a new site.
 */
export type PackageDesignMode = 'content' | 'styles' | 'full';

export interface PackageImportOptions {
  design: PackageDesignMode;
  /** Import the package's font roles and redistributable font files (only with `full`). */
  fonts?: boolean;
  /** Only these entries (by `<section>.<id>`, e.g. `block_templates.hero`); all when absent. */
  only?: string[];
}

/** What the target site already has. */
export interface PackageImportTarget {
  styles: readonly SiteStyle[];
  blockTypes: ReadonlyArray<Pick<BlockType, 'id'> & Record<string, unknown>>;
  blockTemplateIds: readonly string[];
  pageTemplateIds: readonly string[];
  globalBlockIds: readonly string[];
  menuIds: readonly string[];
  menuLocations?: readonly string[];
  pageIds?: readonly string[];
  siteFieldGroups?: readonly SiteFieldGroup[];
  /** Installed apps: extension id → installation id, to reconnect app blocks. */
  extensions?: Readonly<Record<string, string>>;
}

export type PlannedAction = 'create' | 'reuse' | 'rename' | 'replace' | 'skip';

export interface PackageImportPlan {
  styles: Array<{ action: PlannedAction; from: string; to: string; name: string; style: SiteStyle }>;
  block_types: Array<{ action: PlannedAction; from: string; to: string }>;
  block_templates: Array<{ action: PlannedAction; from: string; to: string; name: string }>;
  page_templates: Array<{ action: PlannedAction; from: string; to: string; name: string }>;
  global_blocks: Array<{ action: PlannedAction; from: string; to: string; name: string; kind: PackageGlobalBlock['kind'] }>;
  menus: Array<{ action: PlannedAction; from: string; to: string; name: string; locations: string[] }>;
  site_field_groups: Array<{ action: PlannedAction; id: string }>;
  pages: Array<{ action: PlannedAction; from: string; to: string }>;
  /** Settings keys a `full` import replaces. */
  design: Partial<PackageDesign> | null;
  fonts: PackageFont[];
  media: string[];
  maps: { styles: Map<string, string>; blockTypes: Map<string, string>; globalBlocks: Map<string, string>; pages: Map<string, string>; menus: Map<string, string> };
  warnings: string[];
}

/** Portable name of an app block type: `app:<extension id>/<component>`. */
export const PACKAGE_APP_BLOCK_PREFIX = 'app:';

/** An id not in `taken`: the id itself, else `<id>-2`, `<id>-3`… within `max` characters. */
export function freeId(id: string, taken: ReadonlySet<string>, max = 64): string {
  if (!taken.has(id)) return id;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${id.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No free id for ${id}`);
}

const styleBody = (style: SiteStyle) => canonicalJson({ ...style, id: undefined, name: undefined, description: undefined, updated_at: undefined });
const typeBody = (type: Record<string, unknown>) => canonicalJson({ ...type, created_at: undefined, updated_at: undefined, imported_from: undefined });

/**
 * Work out what importing a package changes on a site, without changing
 * anything: which styles, block types, templates, global blocks, menus and
 * pages are created, reused or renamed, and the id maps that rewrite the
 * imported content. A style or block type the site already has with the same
 * definition is reused; one with the same id but a different definition is
 * created under a new id, so nothing on the site changes unless the import
 * says `replace` (element styles with `full`).
 */
export function planPackageImport(pkg: SitePackage, target: PackageImportTarget, options: PackageImportOptions): PackageImportPlan {
  const c = pkg.contents;
  const wanted = (section: string, id: string) => !options.only || options.only.includes(`${section}.${id}`);
  const warnings: string[] = [];
  const maps = { styles: new Map<string, string>(), blockTypes: new Map<string, string>(), globalBlocks: new Map<string, string>(), pages: new Map<string, string>(), menus: new Map<string, string>() };

  const blockTemplates = (c.block_templates ?? []).filter(t => wanted('block_templates', t.id));
  const pageTemplates = (c.page_templates ?? []).filter(t => wanted('page_templates', t.id));
  const pages = pkg.kind === 'site' ? (c.pages ?? []).filter(p => wanted('pages', p.id)) : [];
  // Global blocks: those chosen plus those the chosen content places.
  const chosenTrees = [...blockTemplates.map(t => t.blocks), ...pageTemplates.map(t => t.blocks ?? []), ...pages.map(p => p.blocks ?? []), ...(c.blocks ? [c.blocks] : [])];
  const globalIds = new Set((c.global_blocks ?? []).filter(g => wanted('global_blocks', g.id)).map(g => g.id));
  for (const tree of chosenTrees) for (const id of collectGlobalRefs(tree)) globalIds.add(id);
  const globals = (c.global_blocks ?? []).filter(g => globalIds.has(g.id));
  const trees = [...chosenTrees, ...globals.map(g => g.blocks)];

  // Block types: site types the content uses (and those chosen), never core or template types.
  const packageTypes = new Map((c.block_types ?? []).map(type => [type.id, type]));
  const usedTypes = new Set(trees.flatMap(tree => blockTypeRefs(tree)));
  const typeIds = [...packageTypes.keys()].filter(id => usedTypes.has(id) || (!options.only ? true : options.only.includes(`block_types.${id}`)));
  const takenTypes = new Set(target.blockTypes.map(type => type.id));
  const existingTypes = new Map(target.blockTypes.map(type => [type.id, type]));
  const blockTypes: PackageImportPlan['block_types'] = typeIds.map(id => {
    const existing = existingTypes.get(id);
    if (existing && typeBody(existing) === typeBody(packageTypes.get(id)!)) return { action: 'reuse', from: id, to: id };
    const to = existing ? freeId(id, takenTypes) : id;
    takenTypes.add(to);
    if (to !== id) maps.blockTypes.set(id, to);
    return { action: to === id ? 'create' : 'rename', from: id, to };
  });
  for (const id of usedTypes) {
    if (!id.startsWith(PACKAGE_APP_BLOCK_PREFIX)) continue;
    const [extensionId, component] = id.slice(PACKAGE_APP_BLOCK_PREFIX.length).split('/');
    const installation = target.extensions?.[extensionId];
    if (installation) maps.blockTypes.set(id, `extension--${installation}--${component}`);
    else warnings.push(`Blocks from the app ${extensionId} need that app installed on the site; until then they show nothing.`);
  }

  // Styles: every style the content uses is created; `styles` and `full` add the rest.
  const packageStyles = new Map((c.styles ?? []).map(style => [style.id, style]));
  const usedStyles = new Set(trees.flatMap(tree => blockStyleRefs(tree)));
  const isElement = (style: SiteStyle) => !!style.role && (STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role);
  const existingStyles = new Map(target.styles.map(style => [style.id, style]));
  const existingRoles = new Map(target.styles.filter(style => style.role).map(style => [style.role!, style]));
  const takenStyles = new Set(target.styles.map(style => style.id));
  const styles: PackageImportPlan['styles'] = [];
  for (const style of packageStyles.values()) {
    if (isElement(style)) {
      if (options.design !== 'full') continue;
      const current = existingRoles.get(style.role!);
      if (current && styleBody(current) === styleBody({ ...style, id: current.id })) styles.push({ action: 'reuse', from: style.id, to: current.id, name: current.name, style: current });
      else styles.push({ action: current ? 'replace' : 'create', from: style.id, to: current?.id ?? style.id, name: style.name, style: { ...style, id: current?.id ?? style.id } });
      if (current) maps.styles.set(style.id, current.id);
      continue;
    }
    if (!usedStyles.has(style.id) && options.design === 'content') continue;
    const existing = existingStyles.get(style.id);
    if (existing && styleBody(existing) === styleBody(style)) { styles.push({ action: 'reuse', from: style.id, to: style.id, name: existing.name, style: existing }); continue; }
    // A standard role is held by one style per site: a copy beside the site's own is a plain class style.
    const roleTaken = !!style.role && existingRoles.has(style.role);
    const to = existing ? freeId(style.id, takenStyles, 48) : style.id;
    takenStyles.add(to);
    const name = to === style.id ? style.name : `${style.name} (imported)`;
    const { role: _role, ...withoutRole } = style;
    styles.push({ action: to === style.id ? 'create' : 'rename', from: style.id, to, name, style: { ...(roleTaken ? withoutRole : style), id: to, name } });
    if (to !== style.id) maps.styles.set(style.id, to);
  }
  for (const id of usedStyles) if (!packageStyles.has(id) && !existingStyles.has(id)) warnings.push(`The content uses the style "${id}", which neither the package nor the site has; those blocks keep their default look.`);

  const plan = <T extends { id: string; name: string }>(list: T[], taken: readonly string[], map?: Map<string, string>) => {
    const used = new Set(taken);
    return list.map(entry => {
      const to = freeId(entry.id, used);
      used.add(to);
      if (map && to !== entry.id) map.set(entry.id, to);
      return { action: (to === entry.id ? 'create' : 'rename') as PlannedAction, from: entry.id, to, name: entry.name };
    });
  };
  const globalPlan = globals.filter(g => g.kind === 'free' || pkg.kind === 'site');
  if (globals.length > globalPlan.length) warnings.push('Headers and footers are imported only with a whole site; the others are skipped.');
  const globalBlocks = plan(globalPlan, target.globalBlockIds, maps.globalBlocks).map((entry, index) => ({ ...entry, kind: globalPlan[index].kind }));

  const pagePlan = plan(pages.map(p => ({ id: p.id, name: p.title })), target.pageIds ?? [], maps.pages).map(({ action, from, to }) => ({ action, from, to }));

  const menus = (c.menus ?? []).filter(menu => wanted('menus', menu.id));
  const takenLocations = new Set(target.menuLocations ?? []);
  const menuPlan = plan(menus, target.menuIds, maps.menus).map((entry, index) => {
    const locations = (menus[index].locations ?? []).filter(location => !takenLocations.has(location));
    if (locations.length < (menus[index].locations ?? []).length) warnings.push(`The menu "${entry.name}" is imported without the locations the site's own menus already fill.`);
    return { ...entry, locations };
  });
  if (pkg.kind !== 'site') for (const menu of menus) {
    const pageItems = JSON.stringify(menu.items).match(/"page_id"/g)?.length ?? 0;
    if (pageItems) warnings.push(`The menu "${menu.name}" links to pages of the package's site; those items are left out.`);
  }

  const existingGroups = new Map((target.siteFieldGroups ?? []).map(group => [group.id, group]));
  const siteFieldGroups = (c.site_fields ?? []).filter(group => pkg.kind === 'site' || wanted('site_fields', group.id)).map(group => {
    const existing = existingGroups.get(group.id);
    if (!existing) return { action: 'create' as PlannedAction, id: group.id };
    if (canonicalJson(existing) === canonicalJson(group)) return { action: 'reuse' as PlannedAction, id: group.id };
    warnings.push(`The site already has a settings page "${group.id}" with other fields; the package's version is skipped.`);
    return { action: 'skip' as PlannedAction, id: group.id };
  });

  const design = options.design === 'full' && c.design ? { ...c.design, ...(options.fonts === false ? { fonts: undefined, font_services: undefined } : {}) } : null;
  const fonts = options.design === 'full' && options.fonts !== false ? (pkg.fonts ?? []) : [];
  if (design?.font_services?.length) warnings.push(`The package uses fonts from ${[...new Set(design.font_services.map(s => s.provider))].join(', ')}; add your own kit or stylesheet for ${design.font_services.flatMap(s => s.families).join(', ')}, or choose other fonts.`);
  const media = [...new Set([...packageMediaRefs(trees), ...packageMediaRefs(c.site_fields ?? []), ...blockTemplates.flatMap(t => t.preview ? [t.preview] : [])])];

  return {
    styles, block_types: blockTypes,
    block_templates: plan(blockTemplates, target.blockTemplateIds),
    page_templates: plan(pageTemplates.map(t => ({ id: t.id, name: t.name })), target.pageTemplateIds),
    global_blocks: globalBlocks, menus: menuPlan, site_field_groups: siteFieldGroups, pages: pagePlan,
    design, fonts, media, maps, warnings,
  };
}

function collectGlobalRefs(blocks: readonly Block[]): string[] {
  const found = new Set<string>();
  walkBlocks(blocks, block => { if (typeof block.data?.global_block_id === 'string') found.add(block.data.global_block_id); });
  return [...found];
}

/** The portable name of a site's app block type (`extension--<installation>--<component>`), given its extension id. */
export function portableBlockType(type: string, installations: Readonly<Record<string, string>>): string {
  const match = /^extension--(.+)--([a-z0-9][a-z0-9_-]*)$/.exec(type);
  if (!match) return type;
  const extensionId = installations[match[1]];
  return extensionId ? `${PACKAGE_APP_BLOCK_PREFIX}${extensionId}/${match[2]}` : type;
}

/** The style ids every block tree of a package uses. */
export function packageStyleRefs(pkg: Pick<SitePackage, 'contents'>): string[] {
  return [...new Set(packageBlockTrees(pkg).flatMap(tree => blockStyleRefs(tree.blocks)))];
}

export function isSitePackage(value: unknown): value is SitePackage {
  return isObject(value) && value.format === SITE_PACKAGE_FORMAT;
}
