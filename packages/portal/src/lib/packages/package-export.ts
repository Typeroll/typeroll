// Export part of a site, or a whole site, as a Typeroll package.
//
// The package carries no organization or site ids: media and redistributable
// font files travel inside it, media references in content become
// `typeroll-media:<id>` tokens, app blocks are named by their extension
// (`app:<extension id>/<component>`) instead of the site's installation, and a
// collection keeps links to the source site's pages only as plain addresses.
//
// A collection (`kind: collection`) holds what was chosen: block templates,
// page templates, free global blocks, block types, styles (those the content
// uses, or all), optionally the design tokens, menus, site field definitions
// and uploaded font files the exporter may pass on. Global blocks, block types
// and styles the chosen content uses come along on their own. A site package
// (`kind: site`) holds everything: pages (published, unlisted and drafts),
// header and footer, menus, site fields with their values, every style and
// the design.
//
// Copied blocks (`kind: clipboard`, block-clipboard.ts in shared) are built
// here too, with `media: 'reference'`: the blocks with the styles, block
// types and free global blocks they use, and no files. Their media keep
// their addresses (listed with the library file each belongs to) and their
// page links stay, so a paste into the same site changes nothing.

import {
  blockStyleRefs, blockTypeRefs, CORE_VERSION, contentPagePath, DEFAULT_CONTENT_TYPE, globalBlockRefs,
  packageMediaUrl, PACKAGE_LIMITS, paths, portableBlockType, rewriteBlockReferences, sitePackageErrors, SITE_PACKAGE_FORMAT,
  SITE_PACKAGE_FORMAT_VERSION, STYLE_ELEMENT_ROLES, validateSiteStyle,
  type Block, type BlockTemplate, type BlockType, type ClipboardMediaRef, type Media, type Menu, type MenuItem, type PackageBlockTemplate,
  type PackageDesign, type PackageFont, type PackageGlobalBlock, type PackageMedia, type PackagePage, type PackagePageTemplate,
  type Page, type Partial as PartialDoc, type SitePackage, type SiteSettings, type SiteStyle,
} from '@typeroll/shared';
import { findReferences, replaceReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';
import { getStore } from '../datastore';
import { vstore } from '../version-store';
import { listBlockTemplates } from '../block-templates-store';
import { listSiteFonts, readSiteFontBytes } from '../fonts/font-library';
import { allowedMediaExtensions, mediaExtension } from '../media/file-types';
import { privateMediaReferences } from '../publishing/media-manifest';
import { appInstallations, isAppBlockType, isRecord, packageBlockTypeOf, rewriteStyleParts } from './package-common';
import { defaultPackageMediaIO, type PackageMediaIO } from './package-media';
import { mediaAddresses } from './demo-media';
import { PackageError, packageIntegrity, sha256Hex, writeSitePackageZip } from './package-zip';

export interface PackageExportSelection {
  kind: 'collection' | 'site' | 'clipboard';
  /** Clipboard packages: the copied blocks. */
  blocks?: Block[];
  block_templates?: string[] | 'all';
  page_templates?: string[] | 'all';
  /** Free global blocks. */
  global_blocks?: string[] | 'all';
  block_types?: string[] | 'all';
  styles?: 'used' | 'all';
  design?: boolean;
  /** Uploaded library families whose files the exporter may pass on. */
  fonts?: { families: string[]; redistributable_confirmed: true };
  menus?: string[] | 'all';
  site_fields?: boolean;
  /** Media to mark as demo content, by media id. */
  demo_media?: string[];
}

export interface PackageExportMeta {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; url?: string };
  licence?: { name: string; url?: string };
  languages?: string[];
}

export interface PackageExportResult {
  manifest: SitePackage;
  files: Map<string, Uint8Array>;
  zip: Uint8Array;
  filename: string;
  sha256: string;
  warnings: string[];
}

export interface BuiltPackage {
  manifest: SitePackage;
  files: Map<string, Uint8Array>;
  warnings: string[];
  /** With `media: 'reference'`: the library files the content uses, by the addresses it uses. */
  media: ClipboardMediaRef[];
  /** Clipboard packages: addresses of the site's pages the blocks link to. */
  page_links: Record<string, string>;
  /**
   * `options.extra`, with its media references made package tokens like the
   * contents (and the files it uses in the package): what a site copy carries
   * beside the package format (site-copy.ts).
   */
  extra?: unknown;
}

export interface PackageBuildOptions {
  media?: PackageMediaIO;
  now?: Date;
  /** `embed` (default): media files travel in the package; `reference`: content keeps its addresses. */
  mediaMode?: 'embed' | 'reference';
  /**
   * Content outside the package format whose media should travel too (a
   * site copy's settings, HTML pages and forms). Returned as `extra` with
   * the same token replacements; never written into the manifest.
   */
  extra?: unknown;
}

export interface ExportCtx { orgId: string; siteId: string; versionId: string }

// ── Input ─────────────────────────────────────────────────────────────────

const SELECTION_KEYS = ['kind', 'block_templates', 'page_templates', 'global_blocks', 'block_types', 'styles', 'design', 'fonts', 'menus', 'site_fields', 'demo_media'];
const META_KEYS = ['id', 'name', 'version', 'description', 'author', 'licence', 'languages'];
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const invalid = (message: string) => new PackageError(message, 400, 'package_selection_invalid');

function idList(value: unknown, key: string, max: number): string[] | 'all' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id || id.length > 100)) throw invalid(`selection.${key} must be "all" or a list of ids`);
  if (value.length > max) throw invalid(`selection.${key} may list at most ${max} ids`);
  return [...new Set(value as string[])];
}

/** Check an export selection from a request body. */
export function parseExportSelection(input: unknown): PackageExportSelection {
  if (!isRecord(input)) throw invalid('selection must be an object');
  const unknown = Object.keys(input).filter(key => !SELECTION_KEYS.includes(key));
  if (unknown.length) throw invalid(`Unknown selection keys: ${unknown.join(', ')}. Accepted: ${SELECTION_KEYS.join(', ')}`);
  if (input.kind !== 'collection' && input.kind !== 'site') throw invalid('selection.kind must be "collection" or "site"');
  const selection: PackageExportSelection = { kind: input.kind };
  selection.block_templates = idList(input.block_templates, 'block_templates', PACKAGE_LIMITS.block_templates);
  selection.page_templates = idList(input.page_templates, 'page_templates', PACKAGE_LIMITS.page_templates);
  selection.global_blocks = idList(input.global_blocks, 'global_blocks', PACKAGE_LIMITS.global_blocks);
  selection.block_types = idList(input.block_types, 'block_types', PACKAGE_LIMITS.block_types);
  selection.menus = idList(input.menus, 'menus', PACKAGE_LIMITS.menus);
  if (input.styles !== undefined && input.styles !== 'used' && input.styles !== 'all') throw invalid('selection.styles must be "used" or "all"');
  if (input.styles) selection.styles = input.styles;
  for (const key of ['design', 'site_fields'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw invalid(`selection.${key} must be true or false`);
    if (input[key] !== undefined) selection[key] = input[key] as boolean;
  }
  if (input.fonts !== undefined && input.fonts !== null) {
    const fonts = input.fonts;
    if (!isRecord(fonts) || !Array.isArray(fonts.families) || fonts.families.some(family => typeof family !== 'string' || !family.trim()) || fonts.families.length > PACKAGE_LIMITS.fonts) {
      throw invalid('selection.fonts must be { families: ["Family name", …], redistributable_confirmed: true }');
    }
    if (fonts.redistributable_confirmed !== true) {
      throw new PackageError('Confirm that the licence of each font allows passing the font files on to others (selection.fonts.redistributable_confirmed: true). Most commercial licences do not; leave the fonts out and the package keeps only the family names.', 400, 'font_redistribution_unconfirmed');
    }
    selection.fonts = { families: [...new Set((fonts.families as string[]).map(family => family.trim()))], redistributable_confirmed: true };
  }
  if (input.demo_media !== undefined) {
    const list = idList(input.demo_media, 'demo_media', PACKAGE_LIMITS.media);
    if (list === 'all') throw invalid('selection.demo_media must be a list of media ids');
    selection.demo_media = list;
  }
  return selection;
}

const person = (value: unknown, key: string): { name: string; url?: string } | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.trim() ? { name: value.trim().slice(0, 120) } : undefined;
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120) throw invalid(`meta.${key} must be a name or { name, url? }`);
  if (value.url !== undefined && (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url) || value.url.length > 500)) throw invalid(`meta.${key}.url must be an http(s) address`);
  return { name: value.name.trim(), ...(typeof value.url === 'string' ? { url: value.url } : {}) };
};

/** Check the package's own details from a request body. */
export function parseExportMeta(input: unknown): PackageExportMeta {
  if (!isRecord(input)) throw invalid('meta must be an object with id, name and version');
  const unknown = Object.keys(input).filter(key => !META_KEYS.includes(key));
  if (unknown.length) throw invalid(`Unknown meta keys: ${unknown.join(', ')}. Accepted: ${META_KEYS.join(', ')}`);
  if (typeof input.id !== 'string' || !SLUG.test(input.id)) throw invalid('meta.id must be a slug (lowercase letters, digits, - and _), e.g. "acme-restaurant-sections"');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw invalid('meta.name is required (at most 120 characters)');
  if (typeof input.version !== 'string' || !/^[\w.+-]{1,32}$/.test(input.version)) throw invalid('meta.version is required, e.g. "1.0.0"');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) throw invalid('meta.description must be at most 2000 characters');
  if (input.languages !== undefined && (!Array.isArray(input.languages) || input.languages.length > 20 || input.languages.some(language => typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)))) {
    throw invalid('meta.languages must be language tags such as "sv" or "en-GB"');
  }
  return {
    id: input.id, name: input.name.trim(), version: input.version,
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}),
    ...(person(input.author, 'author') ? { author: person(input.author, 'author') } : {}),
    ...(person(input.licence, 'licence') ? { licence: person(input.licence, 'licence') } : {}),
    ...(Array.isArray(input.languages) && input.languages.length ? { languages: input.languages as string[] } : {}),
  };
}

// ── Content ───────────────────────────────────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
const isElementStyle = (style: SiteStyle) => !!style.role && (STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role);

function pick<T extends { id: string }>(all: readonly T[], wanted: string[] | 'all' | undefined, label: string): T[] {
  if (!wanted) return [];
  if (wanted === 'all') return [...all];
  const byId = new Map(all.map(entry => [entry.id, entry]));
  const missing = wanted.filter(id => !byId.has(id));
  if (missing.length) throw invalid(`The site has no ${label} ${missing.map(id => `"${id}"`).join(', ')}`);
  return wanted.map(id => byId.get(id)!);
}

/**
 * Collections must not point at the source site's pages: a link to a page
 * keeps its address as a plain URL, a page list loses its pages.
 */
export function detachPageLinks(blocks: Block[], pageUrl: (id: string) => string | undefined, counts: { links: number; lists: number }): Block[] {
  const visit = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) {
      if (key === 'page_ids' && value.length) { counts.lists++; return []; }
      return value.map(item => visit(item));
    }
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [inner, child] of Object.entries(value)) {
      if ((inner === 'page_id' || inner === 'parent_page_id') && typeof child === 'string') { counts.links++; continue; }
      out[inner] = visit(child, inner);
    }
    if (typeof value.page_id === 'string' && !(typeof value.url === 'string' && value.url)) {
      const href = pageUrl(value.page_id);
      if (href !== undefined) out.url = href;
    }
    return out;
  };
  const copy = (block: Block): Block => ({
    ...block,
    data: visit(block.data ?? {}) as Record<string, unknown>,
    ...(block.responsive ? { responsive: visit(block.responsive) as Block['responsive'] } : {}),
    ...(block.children ? { children: block.children.map(copy) } : {}),
    ...(block.slots ? { slots: block.slots.map(slot => slot.map(copy)) } : {}),
  });
  return blocks.map(copy);
}

function withoutPageItems(items: MenuItem[], dropped: { count: number }): MenuItem[] {
  return items.flatMap(item => {
    if (item.type === 'page' || item.type === 'children') { dropped.count++; return []; }
    return [{ ...item, ...(item.children ? { children: withoutPageItems(item.children, dropped) } : {}) }];
  });
}

const SEO_KEYS = ['seo_title', 'seo_description', 'og_title', 'og_description', 'og_image', 'seo_image_alt', 'noindex', 'nofollow',
  'append_seo_suffix', 'breadcrumb_label', 'excerpt', 'kind', 'schema_type', 'json_ld', 'author', 'service', 'image_sizes_default'] as const;

function packagePage(page: Page): PackagePage {
  const seo = Object.fromEntries(SEO_KEYS.filter(key => page[key] !== undefined && page[key] !== null && page[key] !== '').map(key => [key, clone(page[key])]));
  return {
    id: page.id, title: page.title, slug: page.slug ?? '',
    ...(page.path ? { path: page.path } : {}),
    ...(page.parent ? { parent_id: page.parent } : {}),
    status: page.status === 'published' || page.status === 'unlisted' ? page.status : 'draft',
    content_type: 'page',
    ...(page.template ? { template_id: page.template } : {}),
    ...((page as Page & { language?: string }).language ? { language: (page as Page & { language?: string }).language } : {}),
    blocks: clone(page.blocks ?? []),
    ...(page.fields && Object.keys(page.fields).length ? { fields: clone(page.fields) } : {}),
    ...(Object.keys(seo).length ? { seo } : {}),
    ...(typeof page.sort_order === 'number' ? { order: page.sort_order } : {}),
  };
}

function packageDesign(settings: SiteSettings): PackageDesign {
  const fonts = (settings.fonts ?? {}) as Record<string, unknown>;
  const roles = Object.fromEntries(['heading', 'body', 'mono', 'display', 'accent', 'size_base', 'load'].filter(key => fonts[key] !== undefined && fonts[key] !== null).map(key => [key, clone(fonts[key])]));
  const services = (Array.isArray(fonts.services) ? fonts.services : []) as Array<{ provider: 'adobe' | 'bunny' | 'fontshare'; families?: string[] }>;
  const s = settings as SiteSettings & Record<string, unknown>;
  return {
    ...(s.colors ? { colors: clone(s.colors as Record<string, string>) } : {}),
    ...(s.typography ? { typography: clone(s.typography as Record<string, unknown>) } : {}),
    ...(s.design_scales ? { design_scales: clone(s.design_scales as Record<string, unknown>) } : {}),
    ...(s.content_widths ? { content_widths: clone(s.content_widths as Record<string, unknown>) } : {}),
    ...(Object.keys(roles).length ? { fonts: roles as PackageDesign['fonts'] } : {}),
    // A kit or stylesheet is the author's own subscription: only the family names travel.
    ...(services.length ? { font_services: services.map(service => ({ provider: service.provider, families: [...(service.families ?? [])] })) } : {}),
  };
}

export function mediaFileExtension(media: Media): string {
  const type = media.mime_type ?? '';
  const allowed = allowedMediaExtensions(type);
  const own = mediaExtension(media.filename ?? '');
  const ext = own && (!allowed.length || allowed.includes(own)) ? own : allowed[0] ?? own ?? 'bin';
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'bin';
}

/** Transitive site block types a definition builds on: composition blocks and its alias target. */
function typeDependencies(type: BlockType): string[] {
  const out = new Set<string>(blockTypeRefs(type.composition ?? []));
  if (type.expand_to?.target) out.add(type.expand_to.target);
  const item = (type.expand_to?.defaults as Record<string, unknown> | undefined)?.item_block;
  if (typeof item === 'string') out.add(item);
  return [...out];
}

/** The page ids a block tree links to (page_id, parent_page_id, page_ids). */
function pageLinkRefs(blocks: readonly Block[]): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') { if (key === 'page_id' || key === 'parent_page_id') found.add(value); }
    else if (Array.isArray(value)) value.forEach(item => (key === 'page_ids' && typeof item === 'string' ? found.add(item) : visit(item)));
    else if (isRecord(value)) for (const [inner, child] of Object.entries(value)) visit(child, inner);
  };
  const walk = (list: readonly Block[] | undefined) => { for (const block of list ?? []) { visit(block.data ?? {}); walk(block.children); for (const slot of block.slots ?? []) walk(slot); } };
  walk(blocks);
  return [...found];
}

/**
 * Build a package from a site version. Throws PackageError when the selection
 * names something the site does not have, a media file cannot be read, or the
 * result would break the package limits.
 */
export async function exportSitePackage(ctx: ExportCtx, selection: PackageExportSelection, meta: PackageExportMeta, options: { media?: PackageMediaIO; now?: Date } = {}): Promise<PackageExportResult> {
  const { manifest, files, warnings } = await buildSitePackage(ctx, selection, meta, options);
  const total = [...files.values()].reduce((sum, file) => sum + file.byteLength, 0);
  if (total > PACKAGE_LIMITS.uncompressed_bytes) throw new PackageError(`The package would hold ${Math.round(total / 1024 / 1024)} MB of files; at most ${PACKAGE_LIMITS.uncompressed_bytes / 1024 / 1024} MB are allowed`, 413, 'package_too_large');
  const zip = await writeSitePackageZip(manifest, files);
  if (zip.byteLength > PACKAGE_LIMITS.zip_bytes) throw new PackageError(`The package would be ${Math.round(zip.byteLength / 1024 / 1024)} MB; at most ${PACKAGE_LIMITS.zip_bytes / 1024 / 1024} MB are allowed`, 413, 'package_too_large');
  return { manifest, files, zip, filename: `${meta.id}-${meta.version}.typeroll`, sha256: sha256Hex(zip), warnings };
}

/** The package's manifest and files, without the zip: what exportSitePackage writes, and copied blocks. */
export async function buildSitePackage(ctx: ExportCtx, selection: PackageExportSelection, meta: PackageExportMeta, options: PackageBuildOptions = {}): Promise<BuiltPackage> {
  const io = options.media ?? defaultPackageMediaIO;
  const store = getStore();
  const { orgId, siteId, versionId } = ctx;
  const site = selection.kind === 'site';
  const clipboard = selection.kind === 'clipboard';
  const reference = options.mediaMode === 'reference';
  if (clipboard && !selection.blocks?.length) throw invalid('A clipboard package needs the copied blocks');
  const warnings: string[] = [];
  const [settings, partials, pageTemplates, siteTypes, menus, siteFields, pages, contentTypes, templates, library, fontLibrary] = await Promise.all([
    vstore.settings(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.blockTypes(orgId, siteId, versionId),
    vstore.menus(orgId, siteId, versionId),
    vstore.siteFields(orgId, siteId, versionId),
    vstore.pages(orgId, siteId, versionId),
    vstore.contentTypes(orgId, siteId, versionId),
    listBlockTemplates({ orgId, siteId }),
    store.listDocs<Media>(paths.media(orgId, siteId)),
    listSiteFonts(orgId, siteId),
  ]);
  const siteSettings = (settings ?? {}) as SiteSettings;
  const types = new Map(contentTypes.map(type => [type.id, type]));
  if (!types.has('page')) types.set('page', DEFAULT_CONTENT_TYPE);
  const pageUrl = (id: string) => {
    const page = pages.find(candidate => candidate.id === id);
    const type = page ? types.get(page.content_type ?? 'page') : undefined;
    return page && type ? contentPagePath(page, type) ?? undefined : undefined;
  };

  // What was chosen.
  const chosenTemplates: BlockTemplate[] = site ? templates : pick(templates, selection.block_templates, 'block template');
  const chosenPageTemplates = site ? pageTemplates.filter(template => template.id) : pick(pageTemplates.filter(template => template.id), selection.page_templates, 'page template');
  const blockPartials = partials.filter(partial => partial.id && partial.content_mode === 'blocks');
  const freePartials = blockPartials.filter(partial => partial.kind === 'free');
  const chosenPartials: PartialDoc[] = site ? blockPartials : pick(freePartials, selection.global_blocks, 'free global block');
  if (!site && selection.global_blocks && selection.global_blocks !== 'all') {
    const htmlOnly = selection.global_blocks.filter(id => partials.some(partial => partial.id === id && partial.content_mode !== 'blocks'));
    if (htmlOnly.length) throw invalid(`Only block global blocks can be packaged; ${htmlOnly.join(', ')} ${htmlOnly.length === 1 ? 'is' : 'are'} HTML`);
  }
  const chosenPages: Page[] = [];
  if (site) for (const page of pages) {
    if ((page.content_type ?? 'page') !== 'page') { warnings.push(`The page "${page.title}" (${page.id}) is a ${page.content_type} record; content types are not packaged yet, so it is left out.`); continue; }
    if (page.content_mode !== 'blocks') { warnings.push(`The page "${page.title}" (${page.id}) is an HTML page; only block pages are packaged, so it is left out.`); continue; }
    chosenPages.push(page);
  }
  const chosenMenus: Menu[] = site ? menus : pick(menus, selection.menus, 'menu');
  const includeDesign = site || selection.design === true;
  const includeFields = site || selection.site_fields === true;

  // Free global blocks that chosen content places come along, transitively.
  const partialById = new Map(freePartials.map(partial => [partial.id, partial]));
  const included = new Map(chosenPartials.map(partial => [partial.id, partial]));
  let pending = [...chosenTemplates.map(t => t.blocks), ...chosenPageTemplates.map(t => t.blocks ?? []), ...chosenPages.map(p => p.blocks ?? []), ...chosenPartials.map(p => p.blocks ?? []), ...(clipboard ? [selection.blocks!] : [])]
    .flatMap(tree => globalBlockRefs(tree));
  for (let depth = 0; depth < 6 && pending.length; depth++) {
    const next: string[] = [];
    for (const id of pending) {
      if (included.has(id)) continue;
      const partial = partialById.get(id);
      if (!partial) { warnings.push(`Content places the global block "${id}", which the site does not have as a block global block; it is left out.`); continue; }
      included.set(id, partial);
      next.push(...globalBlockRefs(partial.blocks ?? []));
    }
    pending = next;
  }

  // Block types: site types (not app blocks) the content uses, those chosen, and what they build on.
  const exportable = siteTypes.filter(type => type.id && !type.extension && !isAppBlockType(type.id));
  const typeById = new Map(exportable.map(type => [type.id, type]));
  const { byInstallation } = appInstallations(siteTypes);
  const typeMap = new Map<string, string>();
  for (const type of siteTypes) if (type.id && isAppBlockType(type.id)) {
    const portable = portableBlockType(type.id, byInstallation);
    if (portable !== type.id) typeMap.set(type.id, portable);
  }

  // Trees, copied and detached from this site.
  const linkCounts = { links: 0, lists: 0 };
  const prepare = (blocks: Block[] | undefined): Block[] => {
    const copy = rewriteBlockReferences(clone(blocks ?? []), { blockTypes: typeMap });
    // A whole site keeps its pages; copied blocks keep their links for a paste into the same site.
    return site || clipboard ? copy : detachPageLinks(copy, pageUrl, linkCounts);
  };
  const block_templates: PackageBlockTemplate[] = chosenTemplates.map(template => ({
    id: template.id, name: template.name,
    ...(template.description ? { description: template.description } : {}),
    ...(template.kind ? { kind: template.kind } : {}),
    ...(template.category ? { category: template.category } : {}),
    ...(template.preview ? { preview: template.preview } : {}),
    blocks: prepare(template.blocks),
  }));
  const page_templates: PackagePageTemplate[] = chosenPageTemplates.map(template => ({
    id: template.id, name: template.name ?? template.id, label: template.label ?? template.id,
    ...(template.icon ? { icon: template.icon } : {}),
    applies_to: template.applies_to ?? 'any', blocks: prepare(template.blocks),
  }));
  const global_blocks: PackageGlobalBlock[] = [...included.values()].map(partial => ({ id: partial.id, name: partial.name ?? partial.id, kind: partial.kind, blocks: prepare(partial.blocks) }));
  const packagePages = chosenPages.map(page => ({ ...packagePage(page), blocks: prepare(page.blocks) }));
  const copiedBlocks = clipboard ? prepare(selection.blocks) : [];
  const page_links: Record<string, string> = {};
  if (clipboard) for (const id of pageLinkRefs(copiedBlocks)) { const url = pageUrl(id); if (url !== undefined) page_links[id] = url; }
  if (linkCounts.links || linkCounts.lists) {
    warnings.push(`Links to pages of this site are kept as plain addresses (${linkCounts.links} link${linkCounts.links === 1 ? '' : 's'})${linkCounts.lists ? `, and ${linkCounts.lists} list${linkCounts.lists === 1 ? '' : 's'} of chosen pages ${linkCounts.lists === 1 ? 'is' : 'are'} emptied` : ''}; the buyer points them at their own pages.`);
  }

  const trees = [...block_templates.map(t => t.blocks), ...page_templates.map(t => t.blocks ?? []), ...global_blocks.map(g => g.blocks), ...packagePages.map(p => p.blocks ?? []), ...(clipboard ? [copiedBlocks] : [])];
  const wantedTypes = new Set<string>(trees.flatMap(tree => blockTypeRefs(tree)).filter(id => typeById.has(id)));
  for (const id of site ? [...typeById.keys()] : pick(exportable, selection.block_types, 'block type').map(type => type.id)) wantedTypes.add(id);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...wantedTypes]) for (const dependency of typeDependencies(typeById.get(id)!)) {
      if (typeById.has(dependency) && !wantedTypes.has(dependency)) { wantedTypes.add(dependency); changed = true; }
    }
  }
  const block_types = [...wantedTypes].sort().map(id => {
    const type = packageBlockTypeOf(typeById.get(id)!);
    const composition = type.composition ? rewriteBlockReferences(type.composition, { blockTypes: typeMap }) : undefined;
    return { ...type, ...(composition ? { composition } : {}) };
  });
  for (const id of new Set(trees.flatMap(tree => blockTypeRefs(tree)))) {
    if (id.startsWith('app:')) warnings.push(`Blocks from the app ${id.slice(4).split('/')[0]} are included; a site importing the package needs that app installed for them to show.`);
  }

  // Styles: those used (and, with the design, the element styles), or all.
  const siteStyles = (Array.isArray(siteSettings.styles) ? siteSettings.styles : []).flatMap(value => validateSiteStyle(value).style ?? []);
  const usedStyles = new Set([...trees, ...block_types.map(type => type.composition ?? [])].flatMap(tree => blockStyleRefs(tree)));
  const styles = siteStyles.filter(style => site || selection.styles === 'all' || usedStyles.has(style.id) || (includeDesign && isElementStyle(style)))
    .map(style => {
      const { updated_at: _updated, ...rest } = clone(style);
      const parts = rewriteStyleParts(rest.parts, typeMap);
      return { ...rest, ...(parts ? { parts } : {}) };
    });
  for (const id of usedStyles) if (!siteStyles.some(style => style.id === id)) warnings.push(`Content uses the style "${id}", which the site does not have; it is not in the package.`);

  // Menus and site fields.
  const menuDrops = { count: 0 };
  const packageMenus: Menu[] = chosenMenus.map(menu => {
    const { created_at: _c, updated_at: _u, ...rest } = clone(menu);
    return site ? rest : { ...rest, items: withoutPageItems(rest.items ?? [], menuDrops), auto_add_pages: undefined };
  });
  if (menuDrops.count) warnings.push(`${menuDrops.count} menu item${menuDrops.count === 1 ? ' links' : 's link'} to pages of this site and ${menuDrops.count === 1 ? 'is' : 'are'} left out of the collection.`);
  const fieldGroups = includeFields ? clone(siteFields.groups ?? []) : [];

  // Design and fonts.
  const design = includeDesign ? packageDesign(siteSettings) : undefined;
  const fonts: PackageFont[] = [];
  const files = new Map<string, Uint8Array>();
  if (selection.fonts) {
    const known = new Map(fontLibrary.map(font => [font.family.toLowerCase(), font.family]));
    const missing = selection.fonts.families.filter(family => !known.has(family.toLowerCase()));
    if (missing.length) throw invalid(`Only uploaded fonts travel as files; the Fonts library has no ${missing.map(family => `"${family}"`).join(', ')}. Catalog families need no files: the package's design names them.`);
    const families = new Set(selection.fonts.families.map(family => family.toLowerCase()));
    for (const font of fontLibrary.filter(entry => families.has(entry.family.toLowerCase()))) {
      const bytes = await readSiteFontBytes(orgId, siteId, font);
      const sha = sha256Hex(bytes);
      const path = `fonts/${sha}.woff2`;
      if (files.has(path)) continue;
      files.set(path, bytes);
      fonts.push({
        family: font.family, weight: font.weight, style: font.style, path, sha256: sha, bytes: bytes.byteLength,
        ...(font.category ? { category: font.category } : {}), redistributable: true,
        ...(font.licence?.note ? { licence_note: font.licence.note.slice(0, 500) } : {}),
      });
    }
  }
  if (design?.fonts) {
    const packaged = new Set(fonts.map(font => font.family.toLowerCase()));
    for (const role of ['heading', 'body', 'mono', 'display', 'accent'] as const) {
      const family = design.fonts[role];
      if (typeof family === 'string' && fontLibrary.some(font => font.family.toLowerCase() === family.toLowerCase()) && !packaged.has(family.toLowerCase())) {
        warnings.push(`The ${role} font "${family}" is an uploaded font whose files are not in the package; a site importing it needs its own licence and files.`);
      }
    }
  }
  if (design?.font_services?.length) warnings.push(`Fonts from ${[...new Set(design.font_services.map(service => service.provider))].join(', ')} do not travel: the package names the families, and a buyer adds their own kit or stylesheet.`);

  const contents: SitePackage['contents'] = {
    ...(block_templates.length ? { block_templates } : {}),
    ...(page_templates.length ? { page_templates } : {}),
    ...(global_blocks.length ? { global_blocks } : {}),
    ...(block_types.length ? { block_types } : {}),
    ...(styles.length ? { styles } : {}),
    ...(design && Object.keys(design).length ? { design } : {}),
    ...(packageMenus.length ? { menus: packageMenus } : {}),
    ...(fieldGroups.length ? { site_fields: fieldGroups } : {}),
    ...(site && Object.keys(siteFields.values ?? {}).length ? { site_field_values: clone(siteFields.values) } : {}),
    ...(packagePages.length ? { pages: packagePages } : {}),
    ...(clipboard ? { blocks: copiedBlocks } : {}),
  };

  // Media: every library file the contents reference travels as a file and a token.
  const addressOwner = new Map<string, Media>();
  for (const media of library) if (media.id) for (const address of mediaAddresses(media)) if (!addressOwner.has(address)) addressOwner.set(address, media);
  const extraIn = options.extra === undefined ? undefined : clone(options.extra);
  const found = findReferences(JSON.stringify(extraIn === undefined ? contents : [contents, extraIn]), addressOwner.keys());
  const referenced = new Map<string, ClipboardMediaRef>();
  if (reference) for (const address of [...found].sort()) {
    const media = addressOwner.get(address)!;
    const entry = referenced.get(media.id) ?? { site_id: siteId, media_id: media.id, addresses: [], ...(media.filename ? { filename: media.filename.slice(0, 200) } : {}) };
    entry.addresses.push(address);
    referenced.set(media.id, entry);
  }
  if (reference) found.clear();
  const demo = new Set(selection.demo_media ?? []);
  const packageMedia = new Map<string, PackageMedia>();
  const replacements = new Map<string, string>();
  const byMediaId = new Map<string, string>();
  for (const address of [...found].sort()) {
    const media = addressOwner.get(address)!;
    let id = byMediaId.get(media.id);
    if (!id) {
      const bytes = await io.read(orgId, siteId, media);
      if (bytes.byteLength > PACKAGE_LIMITS.media_bytes) throw new PackageError(`The media file ${media.filename} is larger than a package allows (${PACKAGE_LIMITS.media_bytes / 1024 / 1024} MB)`, 413, 'package_too_large');
      const sha = sha256Hex(bytes);
      id = `m-${sha.slice(0, 20)}`;
      byMediaId.set(media.id, id);
      const existing = packageMedia.get(id);
      if (existing) { if (demo.has(media.id)) existing.demo = true; }
      else {
        const path = `media/${sha}.${mediaFileExtension(media)}`;
        files.set(path, bytes);
        packageMedia.set(id, {
          id, path, sha256: sha, bytes: bytes.byteLength, content_type: media.mime_type || 'application/octet-stream',
          filename: (media.filename || `${id}.${mediaFileExtension(media)}`).slice(0, 200),
          ...(media.alt_text ? { alt_text: media.alt_text } : {}),
          ...(media.title ? { title: media.title } : {}),
          ...(media.width ? { width: media.width } : {}),
          ...(media.height ? { height: media.height } : {}),
          ...(demo.has(media.id) || media.demo ? { demo: true } : {}),
        });
      }
    }
    replacements.set(address, packageMediaUrl(id));
  }
  for (const id of demo) if (!byMediaId.has(id)) warnings.push(`The media file ${id} is not used by the exported content, so it is not in the package.`);
  let packaged = replaceReferences(contents, replacements) as SitePackage['contents'];
  let extra = extraIn === undefined ? undefined : replaceReferences(extraIn, replacements);
  // A preview is a media id in the package.
  for (const template of packaged.block_templates ?? []) {
    if (!template.preview) continue;
    const match = /^typeroll-media:([a-z0-9][a-z0-9_-]{0,63})$/.exec(template.preview);
    if (match) template.preview = match[1];
    else { warnings.push(`The preview image of the block template "${template.name}" is not in the Media library; it is left out.`); delete template.preview; }
  }
  // Referenced media keep every address; a paste resolves the ones it may read.
  const unresolved = reference ? [] : [...privateMediaReferences(packaged), ...(extra === undefined ? [] : privateMediaReferences(extra))];
  if (unresolved.length) {
    warnings.push(`${unresolved.length} image or file reference${unresolved.length === 1 ? '' : 's'} point${unresolved.length === 1 ? 's' : ''} at private media that is not in this site's library; ${unresolved.length === 1 ? 'it is' : 'they are'} removed from the package.`);
    // Every private address still left belongs to no file of this library; it would not resolve anywhere else.
    const strip = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(PRIVATE_MEDIA_ADDRESS, '')) as T;
    packaged = strip(packaged);
    if (extra !== undefined) extra = strip(extra);
  }

  const now = options.now ?? new Date();
  const manifest: SitePackage = {
    format: SITE_PACKAGE_FORMAT, format_version: SITE_PACKAGE_FORMAT_VERSION, kind: selection.kind,
    id: meta.id, name: meta.name, version: meta.version,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.licence ? { licence: meta.licence } : {}),
    ...(meta.languages?.length ? { languages: meta.languages } : siteSettings.language ? { languages: [siteSettings.language] } : {}),
    created_at: now.toISOString(),
    generator: { core_version: CORE_VERSION },
    ...(typeof siteSettings.render_version === 'number' ? { render_version: siteSettings.render_version } : {}),
    contents: packaged,
    media: [...packageMedia.values()],
    ...(fonts.length ? { fonts } : {}),
    integrity: packageIntegrity(files),
  };
  const errors = sitePackageErrors(manifest);
  if (errors.length) throw new PackageError(`The site's content cannot be packaged: ${errors[0]}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`, 422, 'package_invalid', { errors: errors.slice(0, 50) });
  return { manifest, files, warnings, media: [...referenced.values()], page_links, ...(extra !== undefined ? { extra } : {}) };
}

/** A private media address of any site, as content stores it. */
const PRIVATE_MEDIA_ADDRESS = /(?:https?:\/\/[^"\s<>()]*?)?\/api\/sites\/[a-zA-Z0-9_%.-]+\/media\/[a-zA-Z0-9_%.-]+\/content(?:\?[^"\s<>()]*)?/g;

/** What the export form can offer: the site's templates, blocks, styles, fonts and media. */
export async function exportableSiteContent(ctx: ExportCtx) {
  const { orgId, siteId, versionId } = ctx;
  const [settings, partials, pageTemplates, siteTypes, templates, library, fontLibrary, menus] = await Promise.all([
    vstore.settings(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.blockTypes(orgId, siteId, versionId),
    listBlockTemplates({ orgId, siteId }),
    getStore().listDocs<Media>(paths.media(orgId, siteId)),
    listSiteFonts(orgId, siteId),
    vstore.menus(orgId, siteId, versionId),
  ]);
  const s = (settings ?? {}) as SiteSettings;
  const styles = (Array.isArray(s.styles) ? s.styles : []).flatMap(value => validateSiteStyle(value).style ?? []);
  const fonts = (s.fonts ?? {}) as Record<string, unknown>;
  const families = new Map<string, 'upload' | 'catalog' | 'service'>();
  for (const font of fontLibrary) families.set(font.family, 'upload');
  for (const service of Array.isArray(fonts.services) ? fonts.services as Array<{ families?: string[] }> : []) for (const family of service.families ?? []) if (!families.has(family)) families.set(family, 'service');
  for (const role of ['heading', 'body', 'mono', 'display', 'accent']) {
    const family = fonts[role];
    if (typeof family === 'string' && family.trim() && family !== 'system' && ![...families.keys()].some(known => known.toLowerCase() === family.toLowerCase())) families.set(family, 'catalog');
  }
  return {
    block_templates: templates.map(template => ({ id: template.id, name: template.name, kind: template.kind ?? null, category: template.category ?? null })),
    page_templates: pageTemplates.filter(template => template.id).map(template => ({ id: template.id, label: template.label ?? template.id, applies_to: template.applies_to ?? 'any' })),
    global_blocks: partials.filter(partial => partial.id && partial.kind === 'free' && partial.content_mode === 'blocks').map(partial => ({ id: partial.id, name: partial.name ?? partial.id })),
    block_types: siteTypes.filter(type => type.id && !type.extension && !isAppBlockType(type.id)).map(type => ({ id: type.id, label: type.label ?? type.id })),
    styles: styles.map(style => ({ id: style.id, name: style.name, role: style.role ?? null })),
    menus: menus.map(menu => ({ id: menu.id, name: menu.name })),
    font_families: [...families].map(([family, source]) => ({ family, source })),
    media: library.filter(media => media.id && (!media.storage || media.storage.state === 'ready')).map(media => ({ id: media.id, filename: media.filename, url: media.cdn_url, demo: media.demo === true })),
  };
}
