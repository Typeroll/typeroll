// Shared "create a new site" logic.
//
// Extracted so both entry points run the exact same bootstrap:
//   - the cookie-auth form POST at /api/sites/create (the dashboard button)
//   - the bearer-auth REST POST at /api/v1/sites (agents / MCP `create_site`)
//
// Keep this the single source of truth for what a fresh site contains
// (settings + home page + header/footer partials + menus + hosting provisioning).
// A new seed step belongs here, not duplicated in a route.
//
// With `from`, the site starts from a whole-site package or another site of
// the organization instead (see "A new site from a package or another site"
// below and packages/new-site-source.ts).

import { randomBytes } from 'node:crypto';
import {
  defaultSiteSettings, getPartialCompositionStarter, LATEST_RENDER_VERSION, MAIN_VERSION_ID, newSiteStyles, paths, siteTimeZone, slugify, STYLE_ELEMENT_ROLES,
} from '@typeroll/shared';
import type { Block, Menu, Page, PackageDesignMode, Site, SitePackage, SiteSettings, SiteStyle } from '@typeroll/shared';
import { getStore, generateDocId } from './datastore';
import { vstore } from './version-store';
import { randomMediaId } from './media-keys';
import { ConnectionError } from './publishing/connections';
import { newSitePublishingMode } from './publishing/readiness';
import { getSiteDomains, saveSiteDomains } from './publishing/domain-config';
import { ensureHostedPlatformHost } from './publishing/site-hosting';
import { declareDomainAtCreation } from './site-domain';
import { parseSiteLanguage, SiteIdTakenError } from './site-create-input';
import { createPage } from './page-create';
import { purgeSiteMedia } from './media-deletion';
import { deleteSiteFont, listSiteFonts } from './fonts/font-library';
import { importSitePackageIntoVersion, preparePackageImport, type PackageImportReport } from './packages/package-import';
import { assertNewSiteSource, type NewSiteImportOptions, type NewSiteSource, type SiteCopyExtra } from './packages/new-site-source';
import type { PackageMediaIO } from './packages/package-media';
import { PackageError } from './packages/package-zip';

export interface CreateSiteInput {
  /** Org that will own the new site. */
  orgId: string;
  /** Display name. Required; drives the slugified site id. */
  name: string;
  /** Optional real hostname. Goes through the domain-declaration flow (CF
   *  Pages register + "point your DNS"), never written as a bare live domain. */
  domain?: string;
  /** Optional site id, already validated (site-create-input.ts). Without it
   *  the id is slugified from `name`. */
  id?: string;
  /** Optional BCP 47 site language, already validated. Default `en`. */
  language?: string;
  /**
   * Internal callers only (never read from a request body): create the site
   * in the `hosted` mode. Refused unless a hosting service is bound.
   */
  publishingMode?: 'hosted';
  /**
   * Start from a site package or another site of the organization, loaded
   * by the caller after its permission checks (new-site-source.ts →
   * loadNewSiteSource). Without it the site starts blank.
   */
  from?: { source: NewSiteSource; options: NewSiteImportOptions };
  /** Who creates the site (an email address or `api-key:<prefix>`): recorded with imported media, fonts and pages. */
  actor?: string;
  /** Tests: the media storage an import writes through. */
  media?: PackageMediaIO;
}

export interface CreateSiteResult {
  siteId: string;
  site: Site & { id: string };
  /** With `from`: what the site started from, what the import did, and notes for the creator. */
  started_from?: {
    kind: NewSiteSource['kind'];
    source: NewSiteSource['label'];
    report: PackageImportReport;
    /** Created on their own because the source had none: the home page, header, footer or menus. */
    defaults: string[];
    warnings: string[];
  };
}

/**
 * Reserve the site document before provisioning or seeding any child data.
 * A requested `id` is reserved exactly or not at all (SiteIdTakenError); an id
 * derived from the name gets a random suffix when it is taken.
 */
export async function reserveSite(orgId: string, name: string, options: { id?: string; language?: string; publishingMode?: 'hosted' } = {}): Promise<{ siteId: string; site: Omit<Site, 'id'> }> {
  const baseId = options.id || slugify(name) || generateDocId();
  const site: Omit<Site, 'id'> = {
    name,
    publishing_mode: newSitePublishingMode(options.publishingMode),
    hosting_group_id: 'default',
    media_id: randomMediaId(),
    hosting_adapter: 'cloudflare',
    ...(options.language ? { language: options.language } : {}),
    created_at: new Date().toISOString(),
  };
  const store = getStore();
  if (options.id && !await store.createDocIfMissing(paths.site(orgId, options.id), site)) throw new SiteIdTakenError(options.id);
  if (options.id) return { siteId: options.id, site };
  let siteId = baseId;
  while (!await store.createDocIfMissing(paths.site(orgId, siteId), site)) {
    siteId = `${baseId}-${randomBytes(6).toString('hex')}`;
  }
  return { siteId, site };
}

/**
 * Bootstrap a new site under `orgId`. Returns the new site id + the stored
 * doc (with `id` injected). Throws only on unexpected datastore failures —
 * The hosted platform address and domain declaration are best-effort and never block
 * site creation (same posture as the original form route).
 */
export async function createSite(input: CreateSiteInput): Promise<CreateSiteResult> {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');
  if (input.from) return createSiteFromSource({ ...input, name }, input.from);
  const domain = input.domain?.trim() || undefined;

  const store = getStore();
  const { siteId, site: reservedSite } = await reserveSite(input.orgId, name, { id: input.id, language: input.language, publishingMode: input.publishingMode });
  const hosted = reservedSite.publishing_mode === 'hosted';

  // Provision only after this request has atomically reserved a new site.
  let hostingConfig: Site['hosting_config'] | undefined;
  if (hosted) {
    // The platform address; a failure is retried by the first publication.
    try {
      hostingConfig = { fallback_subdomain: await ensureHostedPlatformHost(input.orgId, siteId, siteId) };
    } catch (e) {
      console.error(`[create-site] platform address failed for ${siteId}:`, e);
    }
  }

  // NOTE: `domain` is deliberately NOT written here — a bare domain with no
  // lifecycle fields renders as "Live — DNS verified" (legacy-compat). The
  // typed domain becomes the site's desired website host below.
  const site: Omit<Site, 'id'> = {
    ...reservedSite,
    hosting_adapter: 'cloudflare',
    hosting_config: hostingConfig,
    created_at: new Date().toISOString(),
  };
  await store.updateDoc(paths.site(input.orgId, siteId), site);
  await store.setDoc(paths.settings(input.orgId, siteId), {
    ...defaultSiteSettings,
    styles: newSiteStyles(),
    site_name: name,
    // The settings language drives <html lang>; the site document keeps it too.
    ...(input.language ? { language: input.language } : {}),
    // Always set: the usual zone for the language, changed in Settings when the business is elsewhere.
    time_zone: siteTimeZone({ language: input.language ?? defaultSiteSettings.language }),
  });

  // Default home page in HTML mode. Published, so the first publication of a
  // new site has a home page for its header, footer and 404 page to link to.
  await seedHomePage(input.orgId, siteId, name);

  // Seed a published header + footer so the site renders from day one. New
  // sites start at the latest render version, where the starter navigation
  // shows the primary and footer menus seeded below: a page added to the
  // site joins the header by itself.
  for (const kind of ['header', 'footer'] as const) await seedStarterPartial(input.orgId, siteId, kind, LATEST_RENDER_VERSION);

  // Seed the primary and footer menus. A navigation block with source
  // "menu" and menu "location:primary" or "location:footer" shows them; the
  // primary menu adds new top-level pages by itself.
  for (const menu of starterMenus()) await seedMenu(input.orgId, siteId, menu);

  await attachDomain(input.orgId, siteId, domain, hosted);
  return { siteId, site: { ...(site as Site), id: siteId } };
}

/** A published starter header or footer showing the seeded menus. */
async function seedStarterPartial(orgId: string, siteId: string, kind: 'header' | 'footer', renderVersion: number): Promise<void> {
  await getStore().setDoc(paths.partial(orgId, siteId, kind), {
    name: kind === 'header' ? 'Main header' : 'Main footer',
    kind,
    content_mode: 'blocks',
    status: 'published',
    blocks: getPartialCompositionStarter(kind, { links: [{ label: 'Home', href: '/' }], renderVersion }),
  });
}

async function seedMenu(orgId: string, siteId: string, menu: Menu): Promise<void> {
  const now = new Date().toISOString();
  const { id, ...body } = menu;
  await getStore().setDoc(paths.menu(orgId, siteId, id), { ...body, created_at: now, updated_at: now });
}

/** The default home page: HTML, published, so the first publication has a page for its header, footer and 404 page to link to. */
async function seedHomePage(orgId: string, siteId: string, name: string): Promise<void> {
  await getStore().setDoc(`${paths.pages(orgId, siteId)}/home`, {
    title: 'Home',
    slug: 'home',
    content_mode: 'html',
    status: 'published',
    html_content: `<h1>Welcome to ${escapeHtml(name)}</h1><p>Your new site is ready to edit.</p>`,
    date_updated: new Date().toISOString(),
  });
}

/** The typed domain, through the domain-declaration flow; best-effort, it never fails the new site. */
async function attachDomain(orgId: string, siteId: string, domain: string | undefined, hosted: boolean): Promise<void> {
  if (domain && hosted) {
    await declareDomainAtCreation(orgId, siteId, domain);
  } else if (domain) {
    // The site publishes through its organization: the typed domain is saved
    // as the future website host, prepared and verified by Publishing. An
    // invalid one is dropped; it never fails the site that was just created.
    try {
      const config = await getSiteDomains(orgId, siteId);
      await saveSiteDomains(orgId, siteId, { revision: config.revision, website_host: domain, dns_mode: 'automatic' });
    } catch (error) {
      if (!(error instanceof ConnectionError) || error.status !== 400) throw error;
      console.warn(`[create-site] dropped invalid domain "${domain}" for ${siteId}: ${error.message}`);
    }
  }
}

/** The menus every new site starts with; both link the home page by id (none when `homeId` is null). */
export function starterMenus(homeId: string | null = 'home'): Menu[] {
  const items = homeId ? [{ id: 'home', type: 'page' as const, page_id: homeId }] : [];
  return [
    { id: 'primary', name: 'Main menu', locations: ['primary'], auto_add_pages: true, items: structuredClone(items) },
    { id: 'footer', name: 'Footer menu', locations: ['footer'], items: structuredClone(items) },
  ];
}

// ── A new site from a package or another site ─────────────────────────────
//
// The site is reserved and given its settings first: the default settings
// with the standard styles the package does not replace, the language of
// the request (or else of the source), the source's time zone or the usual
// one for the language, and the render version the content was made for.
// A site copy's content types follow, so page templates and pages are
// checked against them. The package is then imported into the empty main
// version with the creator as administrator (package-import.ts): ids are
// kept, styles created, media copied into the new site's library (demo
// files stay marked), and with design "full" the whole look applied. A site
// copy then writes its settings, HTML pages, records, forms and snippets
// (new-site-source.ts). Last, a home page, header, footer and the primary
// and footer menus are created only where the source has none.
//
// When any of it fails, the half-created site is removed again
// (discardNewSite) and the error says so; nothing half-made is left behind.
// The hosted platform address and the domain are set up only after the
// content, so a failure never has them to undo.

const isElementStyle = (style: SiteStyle) => !!style.role && (STYLE_ELEMENT_ROLES as readonly string[]).includes(style.role);

/**
 * The standard styles a new site keeps beside a package's: those the package
 * does not replace. A package style keeps its id (nothing is renamed
 * "(imported)"), a role is held by one style, and with the whole look the
 * package's element styles (body, h1–h6, link) replace the standard ones.
 */
export function newSiteStylesBeside(pkg: SitePackage, design: PackageDesignMode): SiteStyle[] {
  const styles = pkg.contents.styles ?? [];
  const ids = new Set(styles.filter(style => design === 'full' || !isElementStyle(style)).map(style => style.id));
  const elementRoles = new Set(design === 'full' ? styles.filter(isElementStyle).map(style => style.role!) : []);
  const classRoles = new Set(styles.filter(style => style.role && !isElementStyle(style)).map(style => style.role!));
  return newSiteStyles().filter(style => !ids.has(style.id) && (isElementStyle(style) ? !elementRoles.has(style.role!) : !(style.role && classRoles.has(style.role))));
}

/** The render version a package's content was made for, or the latest. */
export function packageRenderVersion(pkg: SitePackage): number {
  const version = pkg.render_version;
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 && version <= LATEST_RENDER_VERSION ? version : LATEST_RENDER_VERSION;
}

/** The site's home page: a page at "/" (an explicit path, or the slug "", "home" or "index"). */
const isHomePage = (page: Pick<Page, 'path' | 'slug' | 'content_type'>) =>
  (page.content_type ?? 'page') === 'page' && (page.path === '/' || (!page.path && ['', 'home', 'index'].includes(page.slug ?? '')));

async function createSiteFromSource(input: CreateSiteInput, from: NonNullable<CreateSiteInput['from']>): Promise<CreateSiteResult> {
  const { source, options } = from;
  assertNewSiteSource(source, options);
  const store = getStore();
  const { orgId, name } = input;
  const pkg = source.read.manifest;
  const copy = source.copy;
  const domain = input.domain?.trim() || undefined;
  const sourceLanguage = source.language ? parseSiteLanguage(source.language) : null;
  const language = input.language ?? (sourceLanguage && sourceLanguage.error === undefined && sourceLanguage.language ? sourceLanguage.language : undefined);
  const renderVersion = packageRenderVersion(pkg);
  const actor = input.actor ?? 'system';

  const { siteId, site: reservedSite } = await reserveSite(orgId, name, { id: input.id, language, publishingMode: input.publishingMode });
  const hosted = reservedSite.publishing_mode === 'hosted';
  const site: Omit<Site, 'id'> = { ...reservedSite, hosting_adapter: 'cloudflare', created_at: new Date().toISOString() };
  const ctx = { orgId, siteId, versionId: MAIN_VERSION_ID };
  let report: PackageImportReport;
  let defaults: string[];
  try {
    await store.updateDoc(paths.site(orgId, siteId), site);
    await store.setDoc(paths.settings(orgId, siteId), {
      ...defaultSiteSettings,
      fonts: { ...defaultSiteSettings.fonts, ...(copy?.font_delivery ?? {}) },
      styles: newSiteStylesBeside(pkg, options.design),
      site_name: name,
      ...(language ? { language } : {}),
      time_zone: siteTimeZone({ time_zone: copy?.time_zone, language: language ?? defaultSiteSettings.language }),
      render_version: renderVersion,
    });
    // A copy's content types first: the import checks page templates and page fields against them.
    for (const type of copy?.content_types ?? []) {
      const { id, ...body } = type;
      await vstore.writeContentType(orgId, siteId, MAIN_VERSION_ID, id, body);
    }
    const prepared = await preparePackageImport(ctx, source.read, {
      design: options.design,
      ...(options.fonts !== undefined ? { fonts: options.fonts } : {}),
      ...(options.font_licence_confirmed !== undefined ? { font_licence_confirmed: options.font_licence_confirmed } : {}),
    }, { extraContent: copy });
    // A copy's other pages keep their ids, so menus keep their items for them.
    for (const page of copy?.pages ?? []) prepared.plan.maps.pages.set(page.id, page.id);
    let convert = (blocks: Block[]) => blocks;
    let replace = <T>(value: T): T => value;
    // The creator administers the new site: the whole look and settings pages need no other permission.
    report = await importSitePackageIntoVersion({ ...ctx, permission: 'admin', design: true, actor }, prepared, {
      media: input.media, onImported: (rewrite, tokens) => { convert = rewrite; replace = tokens; },
    });
    if (copy) await applySiteCopy(ctx, copy, { convert, replace, pageTemplates: prepared.pageTemplateMap, actor });
    defaults = await seedMissingDefaults(ctx, name, renderVersion);
  } catch (error) {
    const removed = await discardNewSite(orgId, siteId).catch((cleanup) => {
      console.error(`[create-site] could not remove the half-created site ${siteId}:`, cleanup);
      return { removed: false };
    });
    throw creationFailure(error, source, siteId, removed.removed);
  }

  if (hosted) {
    // The platform address; a failure is retried by the first publication.
    try {
      site.hosting_config = { fallback_subdomain: await ensureHostedPlatformHost(orgId, siteId, siteId) };
      await store.updateDoc(paths.site(orgId, siteId), { hosting_config: site.hosting_config });
    } catch (e) {
      console.error(`[create-site] platform address failed for ${siteId}:`, e);
    }
  }
  await attachDomain(orgId, siteId, domain, hosted);
  const warnings = [...new Set([...source.warnings, ...report.warnings])];
  return { siteId, site: { ...(site as Site), id: siteId }, started_from: { kind: source.kind, source: source.label, report, defaults, warnings } };
}

/** The error of a creation that failed after the site was reserved, saying the site was removed. */
function creationFailure(error: unknown, source: NewSiteSource, siteId: string, removed: boolean): PackageError {
  const what = source.kind === 'site' ? `the site "${source.label.name}"` : `the package "${source.label.name}"`;
  const reason = (error instanceof Error ? error.message : String(error)).replace(/ (?:What was written before is listed in details\.report and stays on the site\.|Nothing was written\.)$/, '');
  const after = removed ? 'The half-created site was removed again.' : `The half-created site ${siteId} could not be removed completely and is archived; delete it from the site list.`;
  const message = `The new site could not be created from ${what}. ${reason} ${after}`;
  if (error instanceof PackageError) {
    const code = error.code === 'package_import_partial' ? 'site_create_failed' : error.code;
    return new PackageError(message, error.status, code, { ...(error.details ?? {}), site_removed: removed, ...(error.code !== code ? { cause_code: error.code } : {}) });
  }
  const status = (error as { status?: unknown })?.status;
  return new PackageError(message, typeof status === 'number' && status >= 400 && status < 600 ? status : 500, 'site_create_failed', { site_removed: removed });
}

interface CopyTools {
  convert: (blocks: Block[]) => Block[];
  replace: <T>(value: T) => T;
  pageTemplates: ReadonlyMap<string, string>;
  actor: string;
}

/** Write what a site copy carries beside the package, with media and references through the import. */
async function applySiteCopy(ctx: { orgId: string; siteId: string; versionId: string }, copy: SiteCopyExtra, tools: CopyTools): Promise<void> {
  const { orgId, siteId, versionId } = ctx;
  const store = getStore();
  // Content types again, now with their media addresses on the new site.
  for (const type of copy.content_types) {
    const { id, ...body } = tools.replace(type);
    await vstore.writeContentType(orgId, siteId, versionId, id, body);
  }
  if (Object.keys(copy.settings).length) await vstore.writeSettings(orgId, siteId, versionId, tools.replace(copy.settings) as Partial<SiteSettings>);

  // HTML pages and records of other content types, parents first.
  const pending = [...copy.pages];
  const ids = new Set(pending.map(page => page.id));
  const done = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex(page => !page.parent || done.has(page.parent) || !ids.has(page.parent));
    const [page] = pending.splice(index < 0 ? 0 : index, 1);
    const { id, blocks, html_content, fields, template, ...rest } = page;
    await createPage(ctx, {
      ...tools.replace(rest), id,
      ...(page.content_mode === 'html' ? { html_content: tools.replace(html_content ?? '') } : { blocks: tools.convert(blocks ?? []) }),
      ...(fields && Object.keys(fields).length ? { fields: tools.replace(fields) } : {}),
      ...(template ? { template: tools.pageTemplates.get(template) ?? template } : {}),
    } as Partial<Page>, 'import', tools.actor);
    done.add(id);
  }

  const now = new Date().toISOString();
  for (const form of copy.forms) {
    const { id, ...body } = tools.replace(form);
    await store.setDoc(`${paths.forms(orgId, siteId)}/${id}`, { ...body, created_at: now });
  }
  // Snippets are saved, not published: the site's first publication writes their live files.
  for (const snippet of copy.snippets) {
    const { id, ...body } = tools.replace(snippet);
    await store.setDoc(paths.snippet(orgId, siteId, id), { ...body, updated_at: now, updated_by: tools.actor });
  }
}

/** A home page, header, footer and the primary and footer menus, each only where the new site has none. */
async function seedMissingDefaults(ctx: { orgId: string; siteId: string; versionId: string }, name: string, renderVersion: number): Promise<string[]> {
  const { orgId, siteId, versionId } = ctx;
  const [pages, partials, menus] = await Promise.all([vstore.pages(orgId, siteId, versionId), vstore.partials(orgId, siteId, versionId), vstore.menus(orgId, siteId, versionId)]);
  const seeded: string[] = [];
  let homeId: string | null = pages.find(isHomePage)?.id ?? null;
  if (!homeId && !pages.some(page => page.id === 'home')) {
    await seedHomePage(orgId, siteId, name);
    homeId = 'home';
    seeded.push('home page');
  }
  for (const kind of ['header', 'footer'] as const) {
    if (partials.some(partial => partial.id === kind || partial.kind === kind)) continue;
    await seedStarterPartial(orgId, siteId, kind, renderVersion);
    seeded.push(kind);
  }
  for (const menu of starterMenus(homeId)) {
    if (menus.some(existing => existing.id === menu.id || (existing.locations ?? []).some(location => menu.locations?.includes(location)))) continue;
    await seedMenu(orgId, siteId, menu);
    seeded.push(`${menu.locations![0]} menu`);
  }
  return seeded;
}

/**
 * Remove a site whose creation failed: its media files and records, fonts,
 * versions, templates, forms and snippets, then the site document. A media
 * file whose object could not be deleted keeps its record (the only index of
 * those bytes); the site is then archived instead of removed.
 */
export async function discardNewSite(orgId: string, siteId: string): Promise<{ removed: boolean }> {
  const store = getStore();
  const purge = await purgeSiteMedia(orgId, siteId).catch((error) => {
    console.error(`[create-site] media of ${siteId} could not be removed:`, error);
    return null;
  });
  for (const font of await listSiteFonts(orgId, siteId).catch(() => [])) await deleteSiteFont(orgId, siteId, font.id).catch(() => {});
  const versions = await store.listDocs(paths.versions(orgId, siteId)).catch(() => []);
  for (const versionId of new Set([MAIN_VERSION_ID, ...versions.map(version => version.id)])) await store.deleteTree(paths.version(orgId, siteId, versionId));
  for (const collection of [paths.blockTemplates(orgId, siteId), paths.forms(orgId, siteId), paths.snippets(orgId, siteId)]) {
    for (const doc of await store.listDocs(collection)) await store.deleteTree(`${collection}/${doc.id}`);
  }
  if (purge && purge.records_retained === 0) {
    await store.deleteDoc(paths.site(orgId, siteId));
    return { removed: true };
  }
  await store.updateDoc(paths.site(orgId, siteId), {
    lifecycle: { status: 'archived', archived_at: new Date().toISOString(), archived_by: 'system', reason: 'Creating this site from a template failed and some of its media files could not be removed.' },
  });
  return { removed: false };
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
