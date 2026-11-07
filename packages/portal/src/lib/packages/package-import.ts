// Import a Typeroll package into a site.
//
// A package belongs to no organization: anyone can import one, for example a
// template pack bought from someone else. Importing never maps the package's
// styles to "nearest" site styles: every style the imported content uses is
// created on the site. A style is reused only when the site has one with the
// same id and an identical definition; a differing one is created under a new
// id (`hero-2`, named "Hero (imported)") and the imported content is rewritten
// to it. Block types, templates, global blocks and menus follow the same
// rule. Nothing on the site changes unless the import says so: `full` design
// replaces the element styles (body, h1–h6, link), colours, typography,
// scales, content widths and font roles.
//
// The import is planned and validated completely before anything is written
// (inspectSitePackage shows that plan). The writes then run in a fixed order:
// media, fonts, block types, design and styles, global blocks, block
// templates, page templates, menus, site fields, pages. A write that fails
// part-way stops the import and reports what was written
// (`package_import_partial`), so nothing succeeds silently in part.
//
// importSitePackageIntoVersion is the same import for a prepared package, so
// "new site from a package" can import into a fresh site's version.

import {
  BLOCK_TEMPLATE_ID_PATTERN, buildCoreBlockRegistry, contentPagePath, countBlockH1s, DEFAULT_CONTENT_TYPE, designScalesError,
  ensureBlockIds, freeId, contentWidthsError, packageMediaRefs, packageMediaUrl, paths, planPackageImport, PACKAGE_LIMITS,
  rewriteBlockReferences, siteFontsErrors, siteStyleLibraryErrors, styleContrastReport, stylePartErrors, typographyError,
  validateBlockTemplateInput, validateBlockTypeDefinition, validateMenu, validateSiteFieldValues, validateSiteStyle, validColor,
  verifySitePackage, isOnColorValue, ON_COLOR_TOKENS, STYLE_ELEMENT_ROLES,
  type Block, type BlockType, type ContentType, type FieldDefinition, type Media, type Menu, type MenuItem, type PackageDesignMode,
  type PackageImportPlan, type PackageSignatureStatus, type Page, type SharePermission, type SiteFieldGroup, type SitePackage,
  type SiteSettings, type SiteStyle, type TrustedPackageKey,
} from '@typeroll/shared';
import { replaceReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';
import { getStore } from '../datastore';
import { vstore } from '../version-store';
import { markSiteDirty } from '../auto-deploy';
import { listBlockTemplates } from '../block-templates-store';
import { blockTypeResolver } from '../block-type-usage';
import { writableInput } from '../block-type-write';
import { blockTreeInputError } from '../block-tree-input';
import { readStyles } from '../site-styles-store';
import { savePageTemplate } from '../page-template-service';
import { createMenu } from '../menu-write';
import { defineSiteFields, updateSiteFieldValues } from '../site-fields-write';
import { createPage } from '../page-create';
import { validatePageFields } from '../page-fields';
import { addSiteFont, fontSettingsWarnings, FontLibraryError, inspectFontBytes, listSiteFonts } from '../fonts/font-library';
import { appInstallations, isRecord, packageBlockTypeOf, rewriteBlockTypeDefinition, rewriteStyleParts } from './package-common';
import { defaultPackageMediaIO, findMediaBySha, mediaAcceptable, type PackageMediaIO } from './package-media';
import { PackageError, readSitePackageZip, type PackageFiles } from './package-zip';

// ── Options ───────────────────────────────────────────────────────────────

export interface PackageImportRequest {
  design: PackageDesignMode;
  /** With `full`: the package's font roles and font files (default true). */
  fonts?: boolean;
  /** Only these entries (`block_templates.hero`, `menus.main`, …). */
  only?: string[];
  /** The importer confirmed the licence of the package's font files allows use on this site. */
  font_licence_confirmed?: boolean;
}

const OPTION_KEYS = ['design', 'fonts', 'only', 'font_licence_confirmed'];

/** Check import options from a request. Absent options import the content and the styles it uses. */
export function parseImportOptions(input: unknown): PackageImportRequest {
  if (input === undefined || input === null || input === '') return { design: 'content' };
  if (!isRecord(input)) throw new PackageError('options must be an object', 400, 'package_options_invalid');
  const unknown = Object.keys(input).filter(key => !OPTION_KEYS.includes(key));
  if (unknown.length) throw new PackageError(`Unknown options: ${unknown.join(', ')}. Accepted: ${OPTION_KEYS.join(', ')}`, 400, 'package_options_invalid');
  const design = input.design ?? 'content';
  if (design !== 'content' && design !== 'styles' && design !== 'full') throw new PackageError('options.design must be "content", "styles" or "full"', 400, 'package_options_invalid');
  if (input.fonts !== undefined && typeof input.fonts !== 'boolean') throw new PackageError('options.fonts must be true or false', 400, 'package_options_invalid');
  if (input.font_licence_confirmed !== undefined && typeof input.font_licence_confirmed !== 'boolean') throw new PackageError('options.font_licence_confirmed must be true or false', 400, 'package_options_invalid');
  if (input.only !== undefined && (!Array.isArray(input.only) || input.only.length > 5000 || input.only.some(entry => typeof entry !== 'string' || !/^[a-z_]+\.[^\s]{1,100}$/.test(entry)))) {
    throw new PackageError('options.only must be a list of entries such as "block_templates.hero"', 400, 'package_options_invalid');
  }
  return {
    design,
    ...(input.fonts !== undefined ? { fonts: input.fonts as boolean } : {}),
    ...(input.only !== undefined ? { only: input.only as string[] } : {}),
    ...(input.font_licence_confirmed !== undefined ? { font_licence_confirmed: input.font_licence_confirmed as boolean } : {}),
  };
}

// ── Trusted publishers ────────────────────────────────────────────────────

/**
 * Publishers whose signatures this portal trusts, from
 * TYPEROLL_PACKAGE_TRUSTED_KEYS (a JSON list of { key_id, publisher,
 * public_jwk }). An unreadable value trusts nobody; packages still import,
 * shown as unverified.
 */
export function trustedPackageKeys(env: NodeJS.ProcessEnv = process.env): TrustedPackageKey[] {
  const raw = env.TYPEROLL_PACKAGE_TRUSTED_KEYS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    console.warn(JSON.stringify({ event: 'package_trusted_keys_invalid', reason: 'not JSON' }));
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(entry => isRecord(entry) && typeof entry.key_id === 'string' && entry.key_id && entry.key_id.length <= 200
    && typeof entry.publisher === 'string' && entry.publisher.trim() && isRecord(entry.public_jwk) && entry.public_jwk.kty === 'OKP' && entry.public_jwk.crv === 'Ed25519' && typeof entry.public_jwk.x === 'string'
    ? [{ key_id: entry.key_id, publisher: entry.publisher.trim(), public_jwk: { kty: 'OKP', crv: 'Ed25519', x: entry.public_jwk.x } as JsonWebKey }]
    : []);
}

// ── Planning ──────────────────────────────────────────────────────────────

export interface ImportTargetCtx { orgId: string; siteId: string; versionId: string }
export interface ImportCtx extends ImportTargetCtx {
  permission: SharePermission;
  /** Design work without admin (a builder: SiteContext.design): full design, fonts and settings pages. */
  design?: boolean;
  /** Who imports: an email address or `api-key:<prefix>`. Recorded with font licences and revisions. */
  actor: string;
}

type Action = PackageImportPlan['styles'][number]['action'];
export interface PlannedMedia { id: string; filename: string; content_type: string; bytes: number; demo: boolean; action: 'create' | 'reuse'; media_id?: string }
export interface PlannedPage { action: Action; from: string; to: string; slug: string; title: string }

export interface PreparedImport {
  pkg: SitePackage;
  files: Map<string, Uint8Array>;
  options: PackageImportRequest;
  plan: PackageImportPlan;
  signature: { status: PackageSignatureStatus; publisher?: string };
  warnings: string[];
  /** Problems that block the import; empty when it can run. */
  errors: string[];
  /** `admin`: design permission (an administrator or builder); the name is kept for API compatibility. */
  needs: { admin: boolean; design: boolean; font_licence: boolean };
  media: PlannedMedia[];
  pages: PlannedPage[];
  /** The validated block type documents to write, by planned id. */
  blockTypes: Map<string, BlockType>;
  /** The style library after the import, when it changes. */
  styles: SiteStyle[] | null;
  designPatch: Partial<SiteSettings> | null;
  pageTemplateMap: Map<string, string>;
  siteFieldGroups: SiteFieldGroup[];
  existingGroups: SiteFieldGroup[];
}

const PARTIAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
const normalizeId = (id: string) => id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported';

/** Make every planned id fit where it is stored, and keep header and footer in their places. */
function fitIds(plan: PackageImportPlan, target: { blockTemplateIds: string[]; globalBlockIds: string[] }): void {
  const templateIds = new Set([...target.blockTemplateIds, ...plan.block_templates.map(entry => entry.to)]);
  for (const entry of plan.block_templates) {
    if (BLOCK_TEMPLATE_ID_PATTERN.test(entry.to)) continue;
    templateIds.delete(entry.to);
    entry.to = freeId(normalizeId(entry.to), templateIds);
    entry.action = 'rename';
    templateIds.add(entry.to);
  }
  const partialIds = new Set([...target.globalBlockIds, ...plan.global_blocks.map(entry => entry.to)]);
  for (const entry of plan.global_blocks) {
    if (entry.kind !== 'free') {
      // A site has one header and one footer: a site package's replace them.
      plan.maps.globalBlocks.delete(entry.from);
      entry.action = target.globalBlockIds.includes(entry.kind) ? 'replace' : 'create';
      entry.to = entry.kind;
      continue;
    }
    if (PARTIAL_ID.test(entry.to) && entry.to !== 'header' && entry.to !== 'footer') continue;
    partialIds.delete(entry.to);
    entry.to = freeId(normalizeId(entry.to) === 'header' || normalizeId(entry.to) === 'footer' ? `${normalizeId(entry.to)}-block` : normalizeId(entry.to), partialIds);
    entry.action = 'rename';
    partialIds.add(entry.to);
    plan.maps.globalBlocks.set(entry.from, entry.to);
  }
}

/** Every package media id the chosen content uses, beyond the planner's block trees. */
function mediaInUse(pkg: SitePackage, plan: PackageImportPlan, extraContent?: unknown): string[] {
  const c = pkg.contents;
  const pages = new Set(plan.pages.filter(entry => entry.action !== 'skip').map(entry => entry.from));
  const extra = [
    ...(c.pages ?? []).filter(page => pages.has(page.id)).map(page => [page.seo ?? {}, page.fields ?? {}]),
    ...(pkg.kind === 'site' ? [c.site_field_values ?? {}] : []),
    ...(extraContent !== undefined ? [extraContent] : []),
  ];
  return [...new Set([...plan.media, ...packageMediaRefs(extra)])];
}

/**
 * Every page a menu item may keep: each imported page (also those keeping
 * their id, which the plan's id map leaves out) and the map's other entries
 * (pages the caller adds itself, such as a site copy's HTML pages).
 */
function importedPages(pages: readonly PlannedPage[], map: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...pages.filter(entry => entry.action !== 'skip').map(entry => [entry.from, entry.to] as const), ...map]);
}

/** Menu items with page ids through the page map; items for pages the import does not bring are left out. */
function menuWithPages(items: MenuItem[], pages: ReadonlyMap<string, string>): MenuItem[] {
  return items.flatMap(item => {
    if ((item.type === 'page' || item.type === 'children') && (!item.page_id || !pages.has(item.page_id))) return [];
    return [{
      ...item,
      ...(item.page_id ? { page_id: pages.get(item.page_id)! } : {}),
      ...(item.children ? { children: menuWithPages(item.children, pages) } : {}),
    }];
  });
}

function designPatch(design: NonNullable<PackageImportPlan['design']>, settings: SiteSettings, errors: string[]): Partial<SiteSettings> {
  const patch: Record<string, unknown> = {};
  if (design.colors) {
    const colors: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(design.colors)) {
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) { errors.push(`design.colors: "${key}" is not a colour name`); continue; }
      const ok = (ON_COLOR_TOKENS as readonly string[]).includes(key) || key === 'surface_hover' ? isOnColorValue(value) : validColor(value);
      if (!ok) { errors.push(`design.colors.${key} is not a colour`); continue; }
      colors[key] = value;
    }
    patch.colors = { ...((settings.colors ?? {}) as Record<string, unknown>), ...colors };
  }
  if (design.typography !== undefined) { const error = typographyError(design.typography); if (error) errors.push(`design.typography: ${error}`); else patch.typography = clone(design.typography); }
  if (design.design_scales !== undefined) { const error = designScalesError(design.design_scales); if (error) errors.push(`design.design_scales: ${error}`); else patch.design_scales = clone(design.design_scales); }
  if (design.content_widths !== undefined) { const error = contentWidthsError(design.content_widths); if (error) errors.push(`design.content_widths: ${error}`); else patch.content_widths = clone(design.content_widths); }
  if (design.fonts) {
    const fonts = Object.fromEntries(Object.entries(design.fonts).filter(([key, value]) => ['heading', 'body', 'mono', 'display', 'accent', 'size_base', 'load'].includes(key) && value !== undefined && value !== null));
    if (fonts.size_base !== undefined && (typeof fonts.size_base !== 'number' || fonts.size_base < 12 || fonts.size_base > 24)) errors.push('design.fonts.size_base must be a number from 12 to 24');
    const fontErrors = siteFontsErrors(fonts);
    if (fontErrors.length) errors.push(...fontErrors.map(error => `design.${error}`));
    // The site keeps its own font services and delivery; a kit never transfers.
    patch.fonts = { ...((settings.fonts ?? {}) as Record<string, unknown>), ...fonts };
  }
  return patch as Partial<SiteSettings>;
}

/**
 * Plan an import against the site's current state and validate everything
 * it would write. Writes nothing.
 */
export async function preparePackageImport(ctx: ImportTargetCtx, read: PackageFiles, options: PackageImportRequest, deps: {
  trusted?: TrustedPackageKey[];
  /** Content the caller writes itself after the import (a site copy's settings and HTML pages): its package media are imported too. */
  extraContent?: unknown;
} = {}): Promise<PreparedImport> {
  const { manifest: pkg, files } = read;
  const { orgId, siteId, versionId } = ctx;
  const store = getStore();
  const errors: string[] = [];
  const warnings: string[] = [];
  const signature = await verifySitePackage(pkg, deps.trusted ?? trustedPackageKeys());
  if (signature.status === 'invalid') warnings.push('The package signature does not match its contents: it was changed after it was signed. Import it only if you trust where it came from.');
  else if (signature.status === 'unknown_key') warnings.push(`The package is signed with a key this portal does not know (${pkg.signature?.key_id}); its author${pkg.author ? ` "${pkg.author.name}"` : ''} is not verified.`);
  else if (signature.status === 'unsigned' && pkg.author) warnings.push(`The package is not signed; that it comes from "${pkg.author.name}" is not verified.`);

  const [styleSite, siteTypes, templates, pageTemplates, partials, menus, pages, siteFields, settings, library, fontLibrary, contentTypes] = await Promise.all([
    readStyles(ctx),
    vstore.blockTypes(orgId, siteId, versionId),
    listBlockTemplates({ orgId, siteId }),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.menus(orgId, siteId, versionId),
    vstore.pages(orgId, siteId, versionId),
    vstore.siteFields(orgId, siteId, versionId),
    vstore.settings(orgId, siteId, versionId),
    store.listDocs<Media>(paths.media(orgId, siteId)),
    listSiteFonts(orgId, siteId),
    vstore.contentTypes(orgId, siteId, versionId),
  ]);
  const siteSettings = (settings ?? {}) as SiteSettings;
  const ownTypes = siteTypes.filter(type => type.id && !type.extension);
  const target = {
    styles: styleSite.styles,
    blockTypes: ownTypes.map(type => packageBlockTypeOf(type)),
    blockTemplateIds: templates.map(template => template.id),
    pageTemplateIds: pageTemplates.map(template => template.id).filter(Boolean),
    globalBlockIds: partials.map(partial => partial.id).filter(Boolean),
    menuIds: menus.map(menu => menu.id),
    menuLocations: menus.flatMap(menu => menu.locations ?? []),
    pageIds: pages.map(page => page.id),
    siteFieldGroups: siteFields.groups ?? [],
    extensions: appInstallations(siteTypes).byExtension,
  };
  const plan = planPackageImport(pkg, target, { design: options.design, ...(options.fonts !== undefined ? { fonts: options.fonts } : {}), ...(options.only ? { only: options.only } : {}) });
  warnings.push(...plan.warnings);
  fitIds(plan, target);
  if (pkg.kind === 'clipboard' && pkg.contents.blocks?.length) warnings.push('Copied blocks are pasted into a page in the editor; importing adds the styles, block types and media they use.');
  if (plan.global_blocks.some(entry => entry.action === 'replace')) warnings.push('The site\'s header and footer are replaced with the package\'s.');
  const maps = plan.maps;

  // Pages: a site package's pages get free ids (planned) and free addresses.
  const pageType = contentTypes.find(type => type.id === 'page') ?? DEFAULT_CONTENT_TYPE;
  const addresses = new Set(pages.map(page => {
    const type = contentTypes.find(candidate => candidate.id === (page.content_type ?? 'page')) ?? (page.content_type && page.content_type !== 'page' ? undefined : DEFAULT_CONTENT_TYPE);
    return type ? contentPagePath(page, type) : null;
  }).filter((url): url is string => !!url));
  const packagePages = new Map((pkg.contents.pages ?? []).map(page => [page.id, page]));
  const plannedPages: PlannedPage[] = plan.pages.map(entry => {
    const page = packagePages.get(entry.from)!;
    let slug = page.slug ?? '';
    const address = (candidate: string) => contentPagePath({ id: entry.to, title: page.title, slug: candidate, path: page.path, content_mode: 'blocks' } as Page, pageType);
    const url = address(slug);
    if (url && addresses.has(url)) {
      if (url === '/' || page.path) {
        warnings.push(url === '/' ? `The site already has a homepage; the package's homepage "${page.title}" is not imported.` : `The site already has a page at ${page.path}; the package's page "${page.title}" is not imported.`);
        maps.pages.delete(entry.from);
        return { action: 'skip' as Action, from: entry.from, to: entry.to, slug, title: page.title };
      }
      const base = slug;
      for (let n = 2; addresses.has(address(slug) ?? ''); n++) slug = `${base}-${n}`;
      warnings.push(`The address of the package's page "${page.title}" is taken; it is imported as ${address(slug)}.`);
    }
    const final = address(slug);
    if (final) addresses.add(final);
    return { action: entry.action, from: entry.from, to: entry.to, slug, title: page.title };
  });
  plan.pages = plannedPages.map(({ action, from, to }) => ({ action, from, to }));

  // Media: what the content uses, reusing library files with the same bytes.
  const packageMedia = new Map(pkg.media.map(media => [media.id, media]));
  const media: PlannedMedia[] = mediaInUse(pkg, plan, deps.extraContent).flatMap(id => {
    const entry = packageMedia.get(id);
    if (!entry) { errors.push(`The content uses media "${id}", which the package does not contain`); return []; }
    const problem = mediaAcceptable(entry.content_type, entry.bytes);
    if (problem) errors.push(`media ${entry.filename}: ${problem}`);
    const existing = findMediaBySha(library, entry.sha256);
    return [{ id, filename: entry.filename, content_type: entry.content_type, bytes: entry.bytes, demo: entry.demo === true,
      action: existing ? 'reuse' as const : 'create' as const, ...(existing ? { media_id: existing.id } : {}) }];
  });
  plan.media = media.map(entry => entry.id);

  // Block types: validated under their planned ids, with references to renamed types followed.
  const packageTypes = new Map((pkg.contents.block_types ?? []).map(type => [type.id, type]));
  const definitions = plan.block_types.filter(entry => entry.action === 'create' || entry.action === 'rename').map(entry => {
    const definition = rewriteBlockTypeDefinition(clone(packageTypes.get(entry.from)!), { blockTypes: maps.blockTypes, styles: maps.styles });
    return { entry, definition: { ...definition, id: entry.to, name: entry.to } as unknown as BlockType };
  });
  const resolveType = blockTypeResolver([...ownTypes, ...definitions.map(item => item.definition)]);
  const blockTypes = new Map<string, BlockType>();
  const now = new Date().toISOString();
  for (const { entry, definition } of definitions) {
    const input = Object.fromEntries(Object.entries(writableInput(definition as unknown as Record<string, unknown>)).filter(([, value]) => value !== undefined));
    const result = validateBlockTypeDefinition(input, { resolveType, allowScript: true, renderVersion: styleSite.renderVersion });
    const problems = result.problems.filter(problem => problem.severity === 'error');
    if (['validate', 'preview', 'starters'].includes(entry.to)) problems.push({ severity: 'error', path: '/name', message: `"${entry.to}" is reserved by the block type API` });
    if (problems.length) { errors.push(...problems.slice(0, 5).map(problem => `block type ${entry.from}: ${problem.path ? `${problem.path}: ` : ''}${problem.message}`)); continue; }
    const doc: BlockType & { updated_at?: string } = {
      ...result.value, id: entry.to, name: entry.to, label: result.value.label ?? entry.to, category: result.value.category ?? 'custom',
      container: result.value.container ?? false, schema: (result.value.schema ?? []) as FieldDefinition[], origin: 'third_party',
      imported_from: { package_name: pkg.name, version: pkg.version, imported_at: now }, created_at: now, updated_at: now,
    } as BlockType & { updated_at?: string };
    // The definition's own scoping: a stylesheet written before block scoping stays global, as it was.
    if ((definition as BlockType).css_scope === 'block') doc.css_scope = 'block'; else delete doc.css_scope;
    blockTypes.set(entry.to, doc);
  }

  // Styles: the library after the import, checked as a whole.
  const registry = new Map<string, BlockType>(buildCoreBlockRegistry());
  for (const type of ownTypes) registry.set(type.id, type);
  for (const [id, type] of blockTypes) registry.set(id, type);
  let styles: SiteStyle[] | null = null;
  const changedStyles = plan.styles.filter(entry => entry.action !== 'reuse' && entry.action !== 'skip');
  if (changedStyles.length) {
    const next = [...styleSite.styles];
    const claimed = new Set(styleSite.styles.flatMap(style => style.parts ?? []));
    const stamp = new Date().toISOString();
    for (const entry of changedStyles) {
      const parts = rewriteStyleParts(entry.style.parts, maps.blockTypes);
      let style: SiteStyle = { ...clone(entry.style), ...(parts ? { parts } : {}), updated_at: stamp };
      if (entry.action === 'replace') {
        const index = next.findIndex(existing => existing.id === entry.to);
        const replaced = next[index];
        // Element styles keep the site's own block part defaults.
        style = { ...style, id: entry.to, ...(replaced?.parts ? { parts: replaced.parts } : { parts: undefined }) };
        if (!style.parts) delete style.parts;
        if (index >= 0) next[index] = style; else next.push(style);
        continue;
      }
      if (style.parts?.length) {
        const free = style.parts.filter(part => !claimed.has(part));
        if (free.length < style.parts.length) warnings.push(`The style "${style.name}" is imported without the block parts the site's own styles already style (${style.parts.filter(part => claimed.has(part)).join(', ')}).`);
        if (free.length) style.parts = free; else delete style.parts;
        for (const part of free) claimed.add(part);
      }
      const checked = validateSiteStyle(style);
      if (!checked.style) { errors.push(...checked.errors.map(error => `style ${entry.from}: ${error}`)); continue; }
      next.push({ ...checked.style, updated_at: stamp });
    }
    errors.push(...siteStyleLibraryErrors(next));
    for (const entry of changedStyles) {
      const style = next.find(candidate => candidate.id === entry.to);
      if (style) errors.push(...stylePartErrors(style, registry).map(error => `style ${style.name}: ${error}`));
    }
    styles = next;
  }

  // Design (full).
  let patch: Partial<SiteSettings> | null = null;
  if (plan.design) patch = designPatch(plan.design, siteSettings, errors);
  const colors = { ...((siteSettings.colors ?? {}) as Record<string, string>), ...((patch?.colors ?? {}) as Record<string, string>) } as SiteSettings['colors'];
  if (styles) {
    const measured = { renderVersion: styleSite.renderVersion };
    for (const entry of changedStyles) {
      const style = styles.find(candidate => candidate.id === entry.to);
      if (!style) continue;
      const report = styleContrastReport(style, { ...styleSite.colors, ...colors }, measured);
      warnings.push(...report.errors.map(error => `Style contrast on this site: ${error}`), ...report.warnings.map(note => `Style readability: ${note}`));
    }
  }

  // Fonts: the files are checked now; adding them needs the importer's licence confirmation.
  for (const font of plan.fonts) {
    try { inspectFontBytes(files.get(font.path)!); }
    catch (error) { errors.push(`font ${font.family}: ${error instanceof Error ? error.message : 'unreadable'}`); }
  }
  if (patch?.fonts) {
    const known = [...fontLibrary, ...plan.fonts.map(font => ({ family: font.family }))];
    warnings.push(...fontSettingsWarnings(patch.fonts as SiteSettings['fonts'], known));
  }

  // Templates, global blocks and pages: the checks their own write paths make.
  const pageTemplateMap = new Map(plan.page_templates.filter(entry => entry.to !== entry.from).map(entry => [entry.from, entry.to]));
  const typeIds = new Set(contentTypes.map(type => type.id));
  for (const template of pkg.contents.page_templates ?? []) {
    if (!plan.page_templates.some(entry => entry.from === template.id)) continue;
    const error = blockTreeInputError(template.blocks ?? []);
    if (error) errors.push(`page template ${template.id}: ${error}`);
    if (countBlockH1s(template.blocks ?? []) > 1) errors.push(`page template ${template.id}: a Page template should provide only one H1`);
    const restriction = /^content_type:(.+)$/.exec(template.applies_to ?? '')?.[1];
    if (restriction && !typeIds.has(restriction)) warnings.push(`The page template "${template.label ?? template.id}" is for the content type ${restriction}, which the site does not have; it is imported for any page.`);
  }
  for (const template of pkg.contents.block_templates ?? []) {
    if (!plan.block_templates.some(entry => entry.from === template.id)) continue;
    const checked = validateBlockTemplateInput({ name: template.name, ...(template.description ? { description: template.description.slice(0, 500) } : {}), ...(template.kind ? { kind: template.kind } : {}), ...(template.category ? { category: template.category } : {}), blocks: template.blocks });
    if (checked.error) errors.push(`block template ${template.id}: ${checked.error}`);
  }
  for (const entry of plannedPages) {
    if (entry.action === 'skip') continue;
    const page = packagePages.get(entry.from)!;
    const error = blockTreeInputError(page.blocks ?? []);
    if (error) errors.push(`page ${page.id}: ${error}`);
    if (page.fields && Object.keys(page.fields).length) { const fieldError = validatePageFields(pageType, page.fields); if (fieldError) errors.push(`page ${page.id}: ${fieldError}`); }
  }

  // Menus.
  const menuPages = importedPages(plannedPages, maps.pages);
  for (const entry of plan.menus) {
    const menu = pkg.contents.menus!.find(candidate => candidate.id === entry.from)!;
    const { menu: valid, errors: menuErrors } = validateMenu({ ...menu, id: entry.to, locations: entry.locations, items: menuWithPages(menu.items ?? [], menuPages) });
    if (!valid) errors.push(...menuErrors.slice(0, 5).map(error => `menu ${entry.from}: ${error.path} ${error.message}`));
  }

  // Site fields: new settings pages only.
  const createdGroups = plan.site_field_groups.filter(entry => entry.action === 'create').map(entry => (pkg.contents.site_fields ?? []).find(group => group.id === entry.id)!).filter(Boolean);
  const existingNames = new Set((siteFields.groups ?? []).flatMap(group => group.fields.map(field => field.name)));
  for (const group of createdGroups) for (const field of group.fields) if (existingNames.has(field.name)) errors.push(`site field ${field.name}: the site already has a field with this name on another settings page`);
  if (pkg.kind === 'site' && pkg.contents.site_field_values && createdGroups.length) {
    const { errors: valueErrors } = validateSiteFieldValues(createdGroups, pickValues(pkg.contents.site_field_values, createdGroups));
    if (valueErrors.length) warnings.push(`Some site field values in the package do not fit their fields and are left empty (${valueErrors.slice(0, 3).map(error => error.path).join(', ')}).`);
  }

  if (pkg.media.length > PACKAGE_LIMITS.media) errors.push(`The package has more than ${PACKAGE_LIMITS.media} media files`);
  const design = options.design === 'full' || plan.fonts.length > 0 || createdGroups.length > 0;
  const needs = { admin: design, design, font_licence: plan.fonts.length > 0 };
  return {
    pkg, files, options, plan, signature, warnings: [...new Set(warnings)], errors: [...new Set(errors)], needs, media, pages: plannedPages,
    blockTypes, styles, designPatch: patch && Object.keys(patch).length ? patch : null, pageTemplateMap,
    siteFieldGroups: createdGroups, existingGroups: siteFields.groups ?? [],
  };
}

function pickValues(values: Record<string, unknown>, groups: SiteFieldGroup[]): Record<string, unknown> {
  const names = new Set(groups.flatMap(group => group.fields.map(field => field.name)));
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name)));
}

// ── Inspect ───────────────────────────────────────────────────────────────

/** The plan as JSON: id maps become objects. */
export function serializablePlan(prepared: PreparedImport) {
  const { plan } = prepared;
  const object = (map: Map<string, string>) => Object.fromEntries(map);
  return {
    styles: plan.styles.map(({ action, from, to, name }) => ({ action, from, to, name })),
    block_types: plan.block_types,
    block_templates: plan.block_templates,
    page_templates: plan.page_templates,
    global_blocks: plan.global_blocks,
    menus: plan.menus,
    site_field_groups: plan.site_field_groups,
    pages: prepared.pages,
    design: plan.design ? { keys: Object.keys(prepared.designPatch ?? {}), element_styles: plan.styles.filter(entry => entry.style.role && (STYLE_ELEMENT_ROLES as readonly string[]).includes(entry.style.role)).map(entry => entry.to) } : null,
    fonts: plan.fonts.map(({ family, weight, style, bytes, licence_note }) => ({ family, weight, style, bytes, ...(licence_note ? { licence_note } : {}) })),
    media: prepared.media,
    maps: { styles: object(plan.maps.styles), block_types: object(plan.maps.blockTypes), global_blocks: object(plan.maps.globalBlocks), pages: object(plan.maps.pages), menus: object(plan.maps.menus) },
  };
}

export function packageSummary(pkg: SitePackage) {
  const c = pkg.contents;
  return {
    id: pkg.id, name: pkg.name, version: pkg.version, kind: pkg.kind,
    ...(pkg.description ? { description: pkg.description } : {}),
    ...(pkg.author ? { author: pkg.author } : {}),
    ...(pkg.licence ? { licence: pkg.licence } : {}),
    ...(pkg.languages ? { languages: pkg.languages } : {}),
    created_at: pkg.created_at,
    ...(pkg.generator?.core_version ? { core_version: pkg.generator.core_version } : {}),
    counts: {
      block_templates: c.block_templates?.length ?? 0, page_templates: c.page_templates?.length ?? 0, global_blocks: c.global_blocks?.length ?? 0,
      block_types: c.block_types?.length ?? 0, styles: c.styles?.length ?? 0, menus: c.menus?.length ?? 0, site_field_groups: c.site_fields?.length ?? 0,
      pages: c.pages?.length ?? 0, media: pkg.media.length, fonts: pkg.fonts?.length ?? 0, design: c.design ? 1 : 0,
    },
  };
}

/** What importing the package would do to the site, without changing anything. */
export async function inspectSitePackage(orgId: string, siteId: string, versionId: string, bytes: Uint8Array, options: PackageImportRequest = { design: 'content' }, deps: { trusted?: TrustedPackageKey[] } = {}) {
  const prepared = await preparePackageImport({ orgId, siteId, versionId }, await readSitePackageZip(bytes), options, deps);
  return {
    package: packageSummary(prepared.pkg),
    signature: prepared.signature,
    plan: serializablePlan(prepared),
    warnings: prepared.warnings,
    errors: prepared.errors,
    needs: prepared.needs,
  };
}

// ── Import ────────────────────────────────────────────────────────────────

export interface PackageImportReport {
  package: { id: string; name: string; version: string };
  created: {
    styles: string[]; block_types: string[]; block_templates: string[]; page_templates: string[]; global_blocks: string[];
    menus: string[]; site_field_groups: string[]; pages: string[]; media: string[]; fonts: string[];
  };
  reused: { styles: string[]; block_types: string[]; media: string[]; fonts: string[]; site_field_groups: string[] };
  replaced: { styles: string[]; global_blocks: string[] };
  renamed: Array<{ section: string; from: string; to: string }>;
  skipped: Array<{ section: string; id: string }>;
  design: { updated: string[] } | null;
  counts: Record<string, number>;
  warnings: string[];
}

function emptyReport(pkg: SitePackage, warnings: string[]): PackageImportReport {
  return {
    package: { id: pkg.id, name: pkg.name, version: pkg.version },
    created: { styles: [], block_types: [], block_templates: [], page_templates: [], global_blocks: [], menus: [], site_field_groups: [], pages: [], media: [], fonts: [] },
    reused: { styles: [], block_types: [], media: [], fonts: [], site_field_groups: [] },
    replaced: { styles: [], global_blocks: [] },
    renamed: [], skipped: [], design: null, counts: {}, warnings: [...warnings],
  };
}

function finish(report: PackageImportReport): PackageImportReport {
  report.counts = Object.fromEntries(Object.entries(report.created).map(([key, list]) => [key, list.length]));
  return report;
}

/** Refuses an import the caller may not run, or one the plan says cannot run. */
export function assertImportAllowed(prepared: PreparedImport, ctx: Pick<ImportCtx, 'permission' | 'design'>): void {
  if (ctx.permission === 'read') throw new PackageError('Importing a package requires write permission on the site', 403, 'package_permission');
  if (prepared.needs.design && ctx.permission !== 'admin' && !ctx.design) {
    throw new PackageError(prepared.options.design === 'full'
      ? 'Importing the full design (colours, typography, element styles and fonts) requires design permission (an administrator or builder), like the design settings. Import with design "styles" or "content" instead.'
      : 'This import adds fonts or settings pages, which requires design permission on the site (an administrator or builder).', 403, 'package_permission');
  }
  if (prepared.errors.length) throw new PackageError(`The package cannot be imported into this site: ${prepared.errors[0]}${prepared.errors.length > 1 ? ` (and ${prepared.errors.length - 1} more)` : ''}`, 422, 'package_conflict', { errors: prepared.errors.slice(0, 50) });
  if (prepared.needs.font_licence && prepared.options.font_licence_confirmed !== true) {
    throw new PackageError(`The package carries font files (${[...new Set(prepared.plan.fonts.map(font => font.family))].join(', ')}). Confirm that their licence allows use on this website (options.font_licence_confirmed: true), or import without them (options.fonts: false).`, 400, 'font_licence_required');
  }
}

/**
 * Run a prepared import against a site version. Used for an existing site
 * (importSitePackage) and, later, for a new site created from a package.
 */
export async function importSitePackageIntoVersion(ctx: ImportCtx, prepared: PreparedImport, deps: {
  media?: PackageMediaIO;
  /**
   * Called after a complete import with the function that rewrites a block
   * tree of the package the way the import rewrote its content (renamed
   * styles, block types and global blocks; media tokens to the site's
   * files), for blocks the caller places itself, such as a collection entry
   * inserted into a page. `replace` turns the package's media tokens in
   * any other value into the site's addresses.
   */
  onImported?: (convert: (blocks: Block[]) => Block[], replace: <T>(value: T) => T) => void;
} = {}): Promise<PackageImportReport> {
  assertImportAllowed(prepared, ctx);
  const io = deps.media ?? defaultPackageMediaIO;
  const { pkg, plan, files } = prepared;
  const { orgId, siteId, versionId } = ctx;
  const report = emptyReport(pkg, prepared.warnings);
  const maps = { styles: plan.maps.styles, blockTypes: plan.maps.blockTypes, globalBlocks: plan.maps.globalBlocks, pages: plan.maps.pages, menus: plan.maps.menus };
  const tokens = new Map<string, string>();
  let step = 'media';
  const content = <T>(value: T): T => replaceReferences(value, tokens) as T;
  const tree = (blocks: Block[] | undefined): Block[] => ensureBlockIds(content(rewriteBlockReferences(clone(blocks ?? []), maps)));
  const now = new Date().toISOString();
  const source = { package_id: pkg.id, package_name: pkg.name, version: pkg.version, ...(pkg.author ? { author: pkg.author.name } : {}), imported_at: now };

  for (const entry of plan.styles) if (entry.action === 'reuse') report.reused.styles.push(entry.to);
  for (const entry of plan.block_types) if (entry.action === 'reuse') report.reused.block_types.push(entry.to);
  for (const entry of plan.site_field_groups) if (entry.action === 'reuse') report.reused.site_field_groups.push(entry.id);
  for (const entry of plan.site_field_groups) if (entry.action === 'skip') report.skipped.push({ section: 'site_fields', id: entry.id });
  for (const entry of prepared.pages) if (entry.action === 'skip') report.skipped.push({ section: 'pages', id: entry.from });
  const renamed = (section: string, entries: Array<{ action: Action; from: string; to: string }>) => {
    for (const entry of entries) if (entry.action === 'rename') report.renamed.push({ section, from: entry.from, to: entry.to });
  };
  renamed('styles', plan.styles); renamed('block_types', plan.block_types); renamed('block_templates', plan.block_templates);
  renamed('page_templates', plan.page_templates); renamed('global_blocks', plan.global_blocks); renamed('menus', plan.menus); renamed('pages', prepared.pages);

  try {
    // 1. Media, first: everything else refers to it.
    const packageMedia = new Map(pkg.media.map(media => [media.id, media]));
    const library = await getStore().listDocs<Media>(paths.media(orgId, siteId));
    for (const planned of prepared.media) {
      const entry = packageMedia.get(planned.id)!;
      const existing = findMediaBySha(library, entry.sha256);
      if (existing) { tokens.set(packageMediaUrl(planned.id), existing.cdn_url); report.reused.media.push(existing.id); continue; }
      const stored = await io.store(orgId, siteId, {
        bytes: files.get(entry.path)!, sha256: entry.sha256, filename: entry.filename, contentType: entry.content_type,
        altText: entry.alt_text, title: entry.title, width: entry.width, height: entry.height, demo: entry.demo === true,
        source: { package_id: pkg.id, package_version: pkg.version, media_id: entry.id }, actor: ctx.actor,
      });
      tokens.set(packageMediaUrl(planned.id), stored.cdn_url);
      report.created.media.push(stored.id);
      library.push({ id: stored.id, cdn_url: stored.cdn_url, sha256: entry.sha256, filename: entry.filename, created_at: now } as Media);
    }

    // 2. Fonts, before the roles that name them.
    step = 'fonts';
    for (const font of plan.fonts) {
      const note = `From the package ${pkg.name} ${pkg.version}${font.licence_note ? `: ${font.licence_note}` : ''}`.slice(0, 500);
      try {
        const added = await addSiteFont(orgId, siteId, {
          bytes: files.get(font.path)!, filename: `${font.family.replace(/[^A-Za-z0-9]+/g, '-')}.woff2`, family: font.family, weight: font.weight,
          style: font.style, category: font.category, licence_confirmed: true, licence_note: note, by: ctx.actor,
        });
        report.created.fonts.push(added.id);
      } catch (error) {
        if (error instanceof FontLibraryError && error.code === 'font_duplicate') { report.reused.fonts.push(String(error.details?.font_id ?? font.family)); continue; }
        throw error;
      }
    }

    // 3. Block types.
    step = 'block_types';
    for (const [id, doc] of prepared.blockTypes) {
      const { id: _id, ...body } = doc;
      await vstore.writeBlockType(orgId, siteId, versionId, id, body as Partial<BlockType>);
      report.created.block_types.push(id);
    }

    // 4. Design and styles, in one settings write.
    step = 'design';
    const settingsPatch: Partial<SiteSettings> = { ...(prepared.designPatch ?? {}) };
    if (prepared.styles) settingsPatch.styles = content(prepared.styles);
    if (Object.keys(settingsPatch).length) await vstore.writeSettings(orgId, siteId, versionId, settingsPatch);
    if (prepared.designPatch) report.design = { updated: Object.keys(prepared.designPatch) };
    for (const entry of plan.styles) {
      if (entry.action === 'create' || entry.action === 'rename') report.created.styles.push(entry.to);
      if (entry.action === 'replace') report.replaced.styles.push(entry.to);
    }

    // 5. Global blocks.
    step = 'global_blocks';
    const globals = new Map((pkg.contents.global_blocks ?? []).map(global => [global.id, global]));
    for (const entry of plan.global_blocks) {
      const global = globals.get(entry.from)!;
      await vstore.writePartial(orgId, siteId, versionId, entry.to, {
        name: global.name, kind: entry.kind, status: 'published', content_mode: 'blocks', blocks: tree(global.blocks), date_updated: new Date().toISOString(),
      });
      if (entry.action === 'replace') report.replaced.global_blocks.push(entry.to); else report.created.global_blocks.push(entry.to);
    }

    // 6. Block templates, with where they came from.
    step = 'block_templates';
    const blockTemplates = new Map((pkg.contents.block_templates ?? []).map(template => [template.id, template]));
    for (const entry of plan.block_templates) {
      const template = blockTemplates.get(entry.from)!;
      const preview = template.preview ? tokens.get(packageMediaUrl(template.preview)) : undefined;
      const doc = {
        name: template.name, ...(template.description ? { description: template.description.slice(0, 500) } : {}),
        ...(template.kind ? { kind: template.kind } : {}), ...(template.category ? { category: template.category.slice(0, 60) } : {}),
        ...(preview ? { preview } : {}), imported_from: source, blocks: tree(template.blocks), created_at: now, updated_at: now,
      };
      if (!(await getStore().createDocIfMissing(paths.blockTemplate(orgId, siteId, entry.to), doc))) throw new PackageError(`A block template "${entry.to}" was created while importing`, 409, 'package_conflict');
      report.created.block_templates.push(entry.to);
    }

    // 7. Page templates.
    step = 'page_templates';
    const typeIds = new Set((await vstore.contentTypes(orgId, siteId, versionId)).map(type => type.id));
    const pageTemplates = new Map((pkg.contents.page_templates ?? []).map(template => [template.id, template]));
    for (const entry of plan.page_templates) {
      const template = pageTemplates.get(entry.from)!;
      const restriction = /^content_type:(.+)$/.exec(template.applies_to ?? '')?.[1];
      const appliesTo = restriction && !typeIds.has(restriction) ? 'any' : template.applies_to ?? 'any';
      await savePageTemplate({ orgId, siteId, versionId }, entry.to, {
        label: template.label || template.name || entry.to, ...(template.icon ? { icon: template.icon } : {}), applies_to: appliesTo,
        blocks: tree(template.blocks), status: 'published',
      }, true);
      report.created.page_templates.push(entry.to);
    }

    // 8. Menus.
    step = 'menus';
    const menus = new Map((pkg.contents.menus ?? []).map(menu => [menu.id, menu]));
    const menuPages = importedPages(prepared.pages, maps.pages);
    for (const entry of plan.menus) {
      const menu = menus.get(entry.from)! as Menu;
      await createMenu({ orgId, siteId, versionId }, content({
        id: entry.to, name: menu.name, items: menuWithPages(menu.items ?? [], menuPages),
        ...(entry.locations.length ? { locations: entry.locations } : {}), ...(menu.auto_add_pages && pkg.kind === 'site' ? { auto_add_pages: true } : {}),
      }));
      report.created.menus.push(entry.to);
    }

    // 9. Settings pages (site fields), and a site package's values.
    step = 'site_fields';
    if (prepared.siteFieldGroups.length) {
      const options = { permission: ctx.permission, design: ctx.design, updatedBy: ctx.actor, note: `Import of ${pkg.name} ${pkg.version}` };
      await defineSiteFields({ orgId, siteId, versionId }, [...prepared.existingGroups, ...prepared.siteFieldGroups], options);
      report.created.site_field_groups.push(...prepared.siteFieldGroups.map(group => group.id));
      if (pkg.kind === 'site' && pkg.contents.site_field_values) {
        const { values } = validateSiteFieldValues(prepared.siteFieldGroups, content(pickValues(pkg.contents.site_field_values, prepared.siteFieldGroups)));
        if (Object.keys(values).length) await updateSiteFieldValues({ orgId, siteId, versionId }, values, options);
      }
    }

    // 10. Pages of a site package, parents first.
    step = 'pages';
    const packagePages = new Map((pkg.contents.pages ?? []).map(page => [page.id, page]));
    const pending = prepared.pages.filter(entry => entry.action !== 'skip');
    const done = new Set<string>();
    while (pending.length) {
      const index = pending.findIndex(entry => {
        const parent = packagePages.get(entry.from)!.parent_id;
        return !parent || done.has(parent) || !pending.some(other => other.from === parent);
      });
      const [entry] = pending.splice(index < 0 ? 0 : index, 1);
      const page = packagePages.get(entry.from)!;
      const parent = page.parent_id ? maps.pages.get(page.parent_id) ?? null : null;
      const template = page.template_id ? prepared.pageTemplateMap.get(page.template_id) ?? page.template_id : undefined;
      const seo = content(clone(page.seo ?? {})) as Record<string, unknown>;
      await createPage({ orgId, siteId, versionId }, {
        id: entry.to, title: page.title, slug: entry.slug, ...(page.path ? { path: page.path } : {}),
        ...(parent ? { parent } : {}), ...(template ? { template } : {}),
        status: page.status ?? 'draft', content_mode: 'blocks', blocks: tree(page.blocks),
        ...(page.fields && Object.keys(page.fields).length ? { fields: content(clone(page.fields)) } : {}),
        ...(typeof page.order === 'number' ? { sort_order: page.order } : {}),
        ...(page.language ? { language: page.language } : {}),
        ...seo,
      } as Partial<Page>, 'import', ctx.actor);
      done.add(entry.from);
      report.created.pages.push(entry.to);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    finish(report);
    const written = Object.values(report.created).reduce((sum, list) => sum + list.length, 0) + report.replaced.styles.length + report.replaced.global_blocks.length + (report.design ? 1 : 0);
    if (written) await markSiteDirty(orgId, siteId, versionId).catch(() => {});
    const status = error instanceof PackageError ? error.status : (error as { status?: unknown })?.status;
    throw new PackageError(`The import stopped while adding ${step.replace(/_/g, ' ')}: ${reason}. ${written ? 'What was written before is listed in details.report and stays on the site.' : 'Nothing was written.'}`,
      typeof status === 'number' && status >= 400 && status < 600 ? status : 500, 'package_import_partial', { step, report });
  }
  await markSiteDirty(orgId, siteId, versionId);
  deps.onImported?.(tree, content);
  return finish(report);
}

/** Import a `.typeroll` file into a site version. */
export async function importSitePackage(ctx: ImportCtx, bytes: Uint8Array, options: PackageImportRequest, deps: { media?: PackageMediaIO; trusted?: TrustedPackageKey[] } = {}): Promise<PackageImportReport> {
  if (ctx.permission === 'read') throw new PackageError('Importing a package requires write permission on the site', 403, 'package_permission');
  const prepared = await preparePackageImport(ctx, await readSitePackageZip(bytes), options, { trusted: deps.trusted });
  return importSitePackageIntoVersion(ctx, prepared, { media: deps.media });
}

export type { ContentType };
