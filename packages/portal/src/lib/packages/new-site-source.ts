// What a new site starts from: a site package (a `.typeroll` file, or a
// `package` entry of the organization collection) or another site of the
// same organization. lib/site-create.ts creates the site and imports it.
//
// A package belongs to no organization: anyone may start a site from one
// they bought. Another site is copied as a whole-site package built in
// memory (package-export.ts, media embedded), so its media are copied into
// the new site's own library through the normal private media path, styles
// are created (never mapped to "nearest" ones) and every reference is
// rewritten to the new site. Reading each file and writing it again is
// deliberate: copying the record and its storage keys would make two sites
// own the same objects, and deleting a file on one would break the other.
//
// A site copy also carries what the package format does not: the settings
// that are content (SITE_COPY_SETTINGS), HTML pages and records of other
// content types, the content types themselves, forms (without their
// actions) and live snippets. Their media travel with the package.
//
// Never copied: domains and domain declarations, publishing and hosting
// settings, API keys, shares, app installations (listed as warnings), form
// actions and their credentials, integrations and analytics, custom
// scripts, redirects, deploy history and revisions.

import {
  paths, verifySitePackage,
  type ContentType, type Form, type Page, type PackageDesignMode, type PackageSignatureStatus, type SiteSettings, type Snippet, type TrustedPackageKey,
} from '@typeroll/shared';
import type { ExtensionInstallation } from '@typeroll/shared';
import { getStore } from '../datastore';
import { vstore } from '../version-store';
import { listSiteFonts } from '../fonts/font-library';
import { listSnippets } from '../snippet-write';
import { collectionEntryPackage, readCollectionEntry, type CollectionDeps } from '../collections/collections';
import { buildSitePackage } from './package-export';
import { trustedPackageKeys } from './package-import';
import { isRecord } from './package-common';
import { fetchPackageSource, MAX_INLINE_PACKAGE_BYTES } from './package-requests';
import type { PackageMediaIO } from './package-media';
import { PackageError, readSitePackageZip, type PackageFiles } from './package-zip';

// ── Request ───────────────────────────────────────────────────────────────

/** Where a new site starts, as a request names it. */
export type NewSiteFrom =
  | { kind: 'package'; bytes: Uint8Array }
  | { kind: 'collection_entry'; entry_id: string }
  | { kind: 'site'; site_id: string; version?: string };

export interface NewSiteImportOptions {
  /** `full` (default for a new site): the whole look. `styles` / `content`: the site keeps the default look. */
  design: PackageDesignMode;
  /** With `full`: the package's font roles and font files (default true). */
  fonts?: boolean;
  /** The creator confirmed the licence of the font files allows use on the new site. */
  font_licence_confirmed?: boolean;
}

const OPTION_KEYS = ['design', 'fonts', 'font_licence_confirmed'];
const invalid = (message: string) => new PackageError(message, 400, 'site_source_invalid');

/** Import options of a new site; absent options take the whole look. */
export function parseNewSiteImportOptions(input: unknown): NewSiteImportOptions {
  if (input === undefined || input === null || input === '') return { design: 'full' };
  let value = input;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw invalid('options must be JSON'); } }
  if (!isRecord(value)) throw invalid('options must be an object');
  const unknown = Object.keys(value).filter(key => !OPTION_KEYS.includes(key));
  if (unknown.length) throw invalid(`Unknown options: ${unknown.join(', ')}. Accepted: ${OPTION_KEYS.join(', ')}`);
  const design = value.design ?? 'full';
  if (design !== 'full' && design !== 'styles' && design !== 'content') throw invalid('options.design must be "full", "styles" or "content"');
  for (const key of ['fonts', 'font_licence_confirmed'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw invalid(`options.${key} must be true or false`);
  }
  return {
    design,
    ...(value.fonts !== undefined ? { fonts: value.fonts as boolean } : {}),
    ...(value.font_licence_confirmed !== undefined ? { font_licence_confirmed: value.font_licence_confirmed as boolean } : {}),
  };
}

const SITE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/**
 * `from` of a JSON request: { site_id, version? } | { collection_entry } |
 * { package: { data_base64 | source_url } } (the last only where `package` is
 * allowed; the portal sends a file instead).
 */
export async function parseNewSiteFrom(input: unknown, options: { allowPackage: boolean; fetchImpl?: typeof fetch }): Promise<NewSiteFrom> {
  const shapes = options.allowPackage ? '{ site_id, version? }, { collection_entry } or { package: { data_base64 | source_url } }' : '{ site_id, version? } or { collection_entry }';
  if (!isRecord(input)) throw invalid(`from must be ${shapes}`);
  const keys = Object.keys(input);
  if ('site_id' in input) {
    const unknown = keys.filter(key => key !== 'site_id' && key !== 'version');
    if (unknown.length) throw invalid(`from.site_id cannot be combined with ${unknown.join(', ')}; from must be ${shapes}`);
    if (typeof input.site_id !== 'string' || !SITE_ID.test(input.site_id)) throw invalid('from.site_id must be the id of a site of this organization');
    if (input.version !== undefined && (typeof input.version !== 'string' || !input.version.trim())) throw invalid('from.version must be a version id');
    return { kind: 'site', site_id: input.site_id, ...(typeof input.version === 'string' ? { version: input.version.trim() } : {}) };
  }
  if ('collection_entry' in input) {
    if (keys.length > 1) throw invalid(`from.collection_entry cannot be combined with other keys; from must be ${shapes}`);
    if (typeof input.collection_entry !== 'string' || !ENTRY_ID.test(input.collection_entry)) throw invalid('from.collection_entry must be the id of a collection entry');
    return { kind: 'collection_entry', entry_id: input.collection_entry };
  }
  if ('package' in input && options.allowPackage) {
    if (keys.length > 1) throw invalid(`from.package cannot be combined with other keys; from must be ${shapes}`);
    const pkg = input.package;
    if (!isRecord(pkg) || (pkg.data_base64 === undefined) === (pkg.source_url === undefined) || Object.keys(pkg).some(key => key !== 'data_base64' && key !== 'source_url')) {
      throw invalid('from.package must be { data_base64 } or { source_url }');
    }
    if (pkg.source_url !== undefined) return { kind: 'package', bytes: await fetchPackageSource(pkg.source_url, options.fetchImpl) };
    return { kind: 'package', bytes: decodeBase64Package(pkg.data_base64) };
  }
  throw invalid(`from must be ${shapes}`);
}

function decodeBase64Package(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !value) throw invalid('from.package.data_base64 must be the package file, base64-encoded');
  const raw = (value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value).replace(/\s+/g, '');
  if (raw.length > Math.ceil(MAX_INLINE_PACKAGE_BYTES / 3) * 4 + 4) throw new PackageError(`A package sent as data_base64 may be at most ${MAX_INLINE_PACKAGE_BYTES / 1024 / 1024} MB; send a larger one as source_url`, 413, 'package_too_large');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) throw invalid('from.package.data_base64 is not valid base64');
  return new Uint8Array(Buffer.from(raw, 'base64'));
}

// ── Settings of a site copy ───────────────────────────────────────────────

/**
 * How each site setting travels when a site is copied:
 *   copy     content of the site: copied, media references rewritten.
 *   design   the look beyond the package's design: copied with design "full".
 *   package  carried by the whole-site package (design tokens, font roles,
 *            styles): applied by the import with design "full".
 *   new      set for the new site: its name, language, time zone and render
 *            version.
 *   strip    infrastructure of the source site, or credentials: never copied.
 *
 * Typed over every key of SiteSettings, so a new setting does not compile
 * until it is placed here. Keys a stored document carries that the type does
 * not know are not copied.
 */
export const SITE_COPY_SETTINGS: { [K in keyof Required<SiteSettings>]: 'copy' | 'design' | 'package' | 'new' | 'strip' } = {
  agent_instructions: 'copy',
  // Settings of the source's app installations, which are not copied.
  extension_public_config: 'strip',
  design_scales: 'package',
  typography: 'package',
  site_name: 'new',
  responsive_breakpoints: 'design',
  tagline: 'copy',
  logo: 'copy',
  favicon: 'copy',
  apple_touch_icon: 'copy',
  icon_192: 'copy',
  trailing_slash: 'copy',
  iframe_allowed_hosts: 'copy',
  colors: 'package',
  // Roles travel in the package; smoothing and delivery are copied with the look; font services (kits bound to the source's domains) are not.
  fonts: 'package',
  font_plan: 'strip',
  // A copy is a new site being built: it has not been handed over to anyone.
  handover: 'strip',
  contact: 'copy',
  social: 'copy',
  // Tracking and analytics snippets carry the source's account ids.
  scripts_head: 'strip',
  scripts_body_end: 'strip',
  custom_css: 'design',
  render_version: 'new',
  styles: 'package',
  // The banner's wording and policy link are copied; its scripts are not (see siteCopySettings).
  cookie_consent: 'copy',
  language_sections: 'copy',
  language: 'new',
  twitter_handle: 'copy',
  default_seo_suffix: 'copy',
  default_meta_description: 'copy',
  image_sizes_default: 'design',
  default_og_image: 'copy',
  organization: 'copy',
  // Usually names the source's own sitemap address.
  robots_txt: 'strip',
  ai_crawler_policy: 'copy',
  header_behavior: 'design',
  date_format: 'copy',
  time_zone: 'new',
  motion: 'design',
  content_widths: 'package',
  // Indexing switches of the source's publication (a staging site's noindex must not carry over silently).
  sitewide_noindex: 'strip',
  sitewide_nofollow: 'strip',
  // Paths served by the source's other deployments.
  external_routes: 'strip',
  seo_review: 'copy',
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

/** The source's settings a new site copies (SITE_COPY_SETTINGS), with notes on what was left out. */
export function siteCopySettings(settings: SiteSettings, design: PackageDesignMode): { settings: Partial<SiteSettings>; notes: string[] } {
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  const source = settings as SiteSettings & Record<string, unknown>;
  for (const [key, rule] of Object.entries(SITE_COPY_SETTINGS)) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (rule === 'copy' || (rule === 'design' && design === 'full')) out[key] = clone(value);
  }
  const consent = out.cookie_consent as SiteSettings['cookie_consent'] | undefined;
  if (consent && (consent.scripts_necessary || consent.scripts_optional)) {
    const { scripts_necessary: _necessary, scripts_optional: _optional, ...rest } = consent;
    out.cookie_consent = rest;
    notes.push('The cookie banner is copied without its scripts; add the new site\'s own tracking and consent scripts in Settings → Integrations.');
  }
  if (source.scripts_head || source.scripts_body_end) notes.push('Custom scripts (Settings → Advanced) are not copied: they carry the source site\'s tracking and analytics ids.');
  const fonts = (source.fonts ?? {}) as Record<string, unknown>;
  if (Array.isArray(fonts.services) && fonts.services.length) notes.push('Font services (Adobe Fonts kits, Bunny Fonts or Fontshare stylesheets) are not copied: add the new site\'s own kit or stylesheet in Fonts.');
  if (source.robots_txt && source.robots_txt !== 'User-agent: *\nAllow: /\n') notes.push('The custom robots.txt is not copied; the new site starts with the default.');
  if (source.sitewide_noindex || source.sitewide_nofollow) notes.push('The source site\'s sitewide noindex/nofollow switches are not copied.');
  return { settings: out as Partial<SiteSettings>, notes };
}

/** The font keys a copy takes with the whole look besides the roles: smoothing and delivery. */
export function siteCopyFontDelivery(settings: SiteSettings): Partial<SiteSettings['fonts']> {
  const fonts = (settings.fonts ?? {}) as SiteSettings['fonts'];
  return { ...(fonts.smoothing ? { smoothing: fonts.smoothing } : {}), ...(fonts.delivery ? { delivery: fonts.delivery } : {}) };
}

// ── Loading the source ────────────────────────────────────────────────────

/** What a site copy carries beside the package (media references are package tokens). */
export interface SiteCopyExtra {
  settings: Partial<SiteSettings>;
  /** Font smoothing and delivery, with the whole look. */
  font_delivery: Partial<SiteSettings['fonts']>;
  content_types: ContentType[];
  /** HTML pages and records of other content types: what a site package leaves out. */
  pages: Page[];
  /** Forms without their actions (email, webhooks, app targets). */
  forms: Form[];
  snippets: Snippet[];
  time_zone?: string;
}

export interface NewSiteSource {
  kind: NewSiteFrom['kind'];
  read: PackageFiles;
  signature: { status: PackageSignatureStatus; publisher?: string };
  /** What the site was started from, for the report. */
  label: { name: string; version?: string; package_id?: string; site_id?: string; collection_entry?: string };
  /** The source's language: the new site's when the request names none. */
  language?: string;
  copy?: SiteCopyExtra;
  /** Notes for the creator: apps to install, what was not copied. */
  warnings: string[];
}

export interface NewSiteSourceDeps {
  media?: PackageMediaIO;
  collection?: CollectionDeps;
  trusted?: TrustedPackageKey[];
}

/** What the source's pages leave out of a site package: HTML pages and other content types. */
const outsidePackage = (page: Page) => (page.content_type ?? 'page') !== 'page' || page.content_mode !== 'blocks';

/** A page as a copy recreates it: no provenance, revision trail or address of the source's domain. */
function copyPage(page: Page): Page {
  const { _provenance: _p, canonical_url: _c, date_updated: _d, ...rest } = clone(page) as Page & { date_updated?: string };
  return rest as Page;
}

/** A form as a copy recreates it: its fields and messages, not where submissions go. */
function copyForm(form: Form & { id: string }): { form: Form; dropped: boolean } {
  const { actions, target, prefill, option_sources, ...rest } = clone(form) as Form & Record<string, unknown>;
  const dropped = !!(actions?.length || target || prefill?.length || option_sources?.length);
  return { form: { ...rest, actions: [] } as Form, dropped };
}

/**
 * Build the package and the copy of another site of the organization. The
 * caller has checked that the person may read it (same organization only).
 */
async function siteSource(orgId: string, siteId: string, versionId: string, options: NewSiteImportOptions, deps: NewSiteSourceDeps): Promise<NewSiteSource> {
  const store = getStore();
  const site = await store.getDoc<{ name?: string }>(paths.site(orgId, siteId));
  if (!site) throw new PackageError(`Site not found: ${siteId}`, 404, 'site_source_not_found');
  const [settingsDoc, pages, contentTypes, fonts, forms, snippets, installations] = await Promise.all([
    vstore.settings(orgId, siteId, versionId),
    vstore.pages(orgId, siteId, versionId),
    vstore.contentTypes(orgId, siteId, versionId),
    listSiteFonts(orgId, siteId),
    store.listDocs<Form>(paths.forms(orgId, siteId)),
    listSnippets({ orgId, siteId }),
    store.listDocs<ExtensionInstallation>(paths.extensionInstallations(orgId, siteId)),
  ]);
  const settings = (settingsDoc ?? {}) as SiteSettings;
  const warnings: string[] = [];
  const { settings: copied, notes } = siteCopySettings(settings, options.design);
  warnings.push(...notes);

  let droppedActions = 0;
  const copiedForms = forms.filter(form => form.id).map(form => {
    const { form: copy, dropped } = copyForm(form);
    if (dropped) droppedActions++;
    return { ...copy, id: form.id };
  });
  if (droppedActions) warnings.push(`${droppedActions} form${droppedActions === 1 ? ' is' : 's are'} copied without ${droppedActions === 1 ? 'its' : 'their'} actions (email notifications, webhooks, app endpoints): add them again on the new site.`);

  const extra: SiteCopyExtra = {
    settings: copied,
    font_delivery: options.design === 'full' ? siteCopyFontDelivery(settings) : {},
    content_types: contentTypes.filter(type => type.id).map(type => clone(type)),
    pages: pages.filter(page => page.id && outsidePackage(page)).map(copyPage),
    forms: copiedForms,
    snippets: snippets.map(snippet => clone(snippet)),
    ...(settings.time_zone ? { time_zone: settings.time_zone } : {}),
  };

  // Uploaded fonts travel with the whole look; adding them needs the creator's licence confirmation.
  const families = options.design === 'full' && options.fonts !== false ? [...new Set(fonts.map(font => font.family))] : [];
  const built = await buildSitePackage({ orgId, siteId, versionId }, {
    kind: 'site', ...(families.length ? { fonts: { families, redistributable_confirmed: true } } : {}),
  }, { id: siteId, name: (site.name || siteId).slice(0, 120), version: '1' }, { media: deps.media, extra });

  // The package leaves HTML pages and other content types out with a warning each; the copy carries them.
  const builtWarnings = built.warnings.filter(warning => !/^The page ".*" \(.*\) is (?:an HTML page|a .* record);/.test(warning));
  warnings.push(...builtWarnings);
  warnings.push(...appWarnings(installations));

  return {
    kind: 'site', read: { manifest: built.manifest, files: built.files }, signature: { status: 'unsigned' },
    label: { name: site.name || siteId, site_id: siteId }, language: settings.language,
    copy: built.extra as SiteCopyExtra, warnings,
  };
}

const appWarnings = (installations: ExtensionInstallation[]) => [...new Set(installations
  .filter(installation => installation.status === 'enabled' || installation.status === 'disabled' || installation.status === 'pending')
  .map(installation => installation.extension_id).filter(Boolean))]
  .map(app => `The source site uses the app ${app}: install ${app} on the new site; apps, their settings and credentials are not copied.`);

/**
 * What a copy of another site would bring, without reading its media: for
 * the new-site form, before the person confirms. The copy itself is built
 * by loadNewSiteSource.
 */
export async function previewSiteSource(orgId: string, siteId: string, versionId: string, options: NewSiteImportOptions) {
  const store = getStore();
  const site = await store.getDoc<{ name?: string }>(paths.site(orgId, siteId));
  if (!site) throw new PackageError(`Site not found: ${siteId}`, 404, 'site_source_not_found');
  const [settingsDoc, pages, partials, menus, media, fonts, installations] = await Promise.all([
    vstore.settings(orgId, siteId, versionId),
    vstore.pages(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.menus(orgId, siteId, versionId),
    store.listDocs<{ demo?: boolean }>(paths.media(orgId, siteId)),
    listSiteFonts(orgId, siteId),
    store.listDocs<ExtensionInstallation>(paths.extensionInstallations(orgId, siteId)),
  ]);
  const settings = (settingsDoc ?? {}) as SiteSettings;
  const families = options.design === 'full' && options.fonts !== false ? [...new Set(fonts.map(font => font.family))] : [];
  return {
    source: { name: site.name || siteId, site_id: siteId },
    package: null,
    counts: { pages: pages.length, global_blocks: partials.length, menus: menus.length, media: media.length, demo_media: media.filter(item => item.demo).length, fonts: families.length },
    signature: { status: 'unsigned' as PackageSignatureStatus },
    language: settings.language ?? null,
    needs: { font_licence: families.length > 0, fonts: families },
    warnings: [...siteCopySettings(settings, options.design).notes, ...appWarnings(installations)],
    errors: [] as string[],
  };
}

/** A package file or a collection entry, checked for being a whole site. */
async function packageSource(kind: 'package' | 'collection_entry', read: PackageFiles, label: NewSiteSource['label'], deps: NewSiteSourceDeps): Promise<NewSiteSource> {
  const pkg = read.manifest;
  const signature = await verifySitePackage(pkg, deps.trusted ?? trustedPackageKeys());
  return {
    kind, read, signature,
    label: { ...label, name: pkg.name, version: pkg.version, package_id: pkg.id },
    language: pkg.languages?.[0], warnings: [],
  };
}

/**
 * Read what a new site starts from. Package bytes are read and verified;
 * a collection entry is read from the organization's collection; another
 * site is packaged with its media. Throws PackageError before anything of
 * the new site exists.
 */
export async function loadNewSiteSource(orgId: string, from: NewSiteFrom & { version_id?: string }, options: NewSiteImportOptions, deps: NewSiteSourceDeps & {
  /** A collection entry's manifest only, without reading its files: for a preview. */
  manifestOnly?: boolean;
} = {}): Promise<NewSiteSource> {
  if (from.kind === 'package') return packageSource('package', await readSitePackageZip(from.bytes), { name: '' }, deps);
  if (from.kind === 'collection_entry') {
    const entry = await readCollectionEntry(orgId, from.entry_id);
    if (!entry) throw new PackageError(`Collection entry not found: ${from.entry_id}`, 404, 'site_source_not_found');
    if (entry.kind !== 'package' || entry.package.kind !== 'site') throw new PackageError(`The collection entry "${entry.name}" is a ${entry.kind.replace(/_/g, ' ')}, not a whole site: create the site, then insert it from the collection.`, 400, 'package_not_a_site');
    const read = deps.manifestOnly ? { manifest: clone(entry.package), files: new Map<string, Uint8Array>() } : await collectionEntryPackage(orgId, entry, deps.collection);
    return packageSource('collection_entry', read, { name: entry.name, collection_entry: entry.id }, deps);
  }
  return siteSource(orgId, from.site_id, from.version_id ?? 'main', options, deps);
}

/**
 * Refuse a source a new site cannot start from, before the site is created:
 * not a whole site, a broken signature, or font files without the creator's
 * licence confirmation.
 */
export function assertNewSiteSource(source: NewSiteSource, options: NewSiteImportOptions): void {
  const pkg = source.read.manifest;
  if (pkg.kind !== 'site') {
    throw new PackageError(`"${pkg.name}" holds ${pkg.kind === 'clipboard' ? 'copied blocks' : 'templates and parts'}, not a whole site: create the site, then import the package from Packages.`, 400, 'package_not_a_site');
  }
  if (source.signature.status === 'invalid') {
    throw new PackageError('The package signature does not match its contents: it was changed after it was signed. A new site cannot start from it.', 422, 'package_signature_invalid');
  }
  const fonts = options.design === 'full' && options.fonts !== false ? pkg.fonts ?? [] : [];
  if (fonts.length && options.font_licence_confirmed !== true) {
    throw new PackageError(`The ${source.kind === 'site' ? 'site' : 'package'} carries font files (${[...new Set(fonts.map(font => font.family))].join(', ')}). Confirm that their licence allows use on the new site (options.font_licence_confirmed: true), or start without them (options.fonts: false).`, 400, 'font_licence_required');
  }
}

/** What a preview shows before a site is created from the source. */
export function newSiteSourcePreview(source: NewSiteSource, options: NewSiteImportOptions) {
  const pkg = source.read.manifest;
  const c = pkg.contents;
  const fonts = [...new Set((pkg.fonts ?? []).map(font => font.family))];
  const problems: string[] = [];
  try { assertNewSiteSource(source, { ...options, font_licence_confirmed: true }); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  return {
    source: source.label,
    counts: {
      pages: (c.pages?.length ?? 0) + (source.copy?.pages.length ?? 0), global_blocks: c.global_blocks?.length ?? 0, menus: c.menus?.length ?? 0,
      media: pkg.media.length, demo_media: pkg.media.filter(media => media.demo).length, fonts: fonts.length,
    },
    package: {
      id: pkg.id, name: pkg.name, version: pkg.version, kind: pkg.kind,
      ...(pkg.description ? { description: pkg.description } : {}),
      ...(pkg.author ? { author: pkg.author } : {}),
      ...(pkg.licence ? { licence: pkg.licence } : {}),
      ...(pkg.languages?.length ? { languages: pkg.languages } : {}),
      counts: {
        styles: c.styles?.length ?? 0, block_types: c.block_types?.length ?? 0, block_templates: c.block_templates?.length ?? 0,
        page_templates: c.page_templates?.length ?? 0, site_field_groups: c.site_fields?.length ?? 0,
      },
    },
    signature: source.signature,
    language: source.language ?? null,
    needs: { font_licence: fonts.length > 0, fonts },
    warnings: source.warnings,
    errors: problems,
  };
}
