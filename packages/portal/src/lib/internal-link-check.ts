import {
  applyTrailingSlash,
  resolveContentPage,
  DEFAULT_CONTENT_TYPE,
  pageContentValues,
  facetRoutes,
  matchRedirect,
  paths,
  sortRedirectsForEmit,
} from '@typeroll/shared';
import type {
  Media,
  Menu,
  MenuItem,
  Page,
  Partial as PartialDoc,
  Redirect,
  Site,
} from '@typeroll/shared';
import type { ReadWriteStore } from './datastore';
import { createPageAnchorIndex, fragmentResolves } from './page-anchor-ids';
import { pageUrlFromDoc } from './page-paths';
import { publicUrlsFor } from './site-public-urls';
import { vstore } from './version-store';

export interface BrokenInternalLink {
  from: string;
  href: string;
  resolved_path: string;
  /**
   * `missing_page`: a menu item links to a page id that does not exist.
   * `missing_fragment`: the Page at `resolved_path` exists but has no element
   * whose id is `fragment` (same-page `#x` links resolve to their own Page).
   */
  reason: 'missing_route' | 'broken_redirect' | 'redirect_loop' | 'invalid_url' | 'missing_page' | 'missing_fragment';
  /** The link's `#fragment` without `#`, on `missing_fragment` only. */
  fragment?: string;
}

export interface InternalLinkReport {
  checked_links: number;
  unique_internal_links: number;
  valid_links: number;
  redirected_links: number;
  broken_links: number;
  broken: BrokenInternalLink[];
  draft_sources: string[];
  unpublished_targets: Array<{ from: string; href: string; resolved_path: string; page_id: string }>;
  routes: number;
  resources_scanned: number;
  /** Resolved internal links by source, only with `includeLinks` (used for orphan-page checks). */
  links?: Array<{ from: string; path: string }>;
}

interface LinkSource { label: string; value: unknown; basePath: string; page?: Page }

/** Check internal hrefs entirely against the versioned datastore snapshot.
 * No deployed site or network request is needed. */
export async function checkInternalLinks(args: {
  store: ReadWriteStore;
  orgId: string;
  siteId: string;
  versionId: string;
  site: Site & { id: string };
  includeLinks?: boolean;
  /** Check `#fragment`s against the target Page's rendered ids (default true). */
  fragments?: boolean;
}): Promise<InternalLinkReport> {
  const { store, orgId, siteId, versionId } = args;
  const checkFragments = args.fragments !== false;
  const [pages, partials, contentTypes, templates, redirects, media, settings, menus, blockTypes, siteFields] = await Promise.all([
    vstore.pages(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.contentTypes(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.redirects(orgId, siteId, versionId),
    store.listDocs<Media>(paths.media(orgId, siteId)),
    vstore.settings(orgId, siteId, versionId),
    vstore.menus(orgId, siteId, versionId),
    checkFragments ? vstore.blockTypes(orgId, siteId, versionId) : [],
    checkFragments ? vstore.siteFields(orgId, siteId, versionId) : null,
  ]);
  const trailingSlash = settings?.trailing_slash ?? 'always';
  const types = new Map(contentTypes.map(type => [type.id, type]));
  if (!types.has('page')) types.set('page', DEFAULT_CONTENT_TYPE);
  const routes = new Set<string>(['/404.html', '/robots.txt', '/sitemap.xml']);
  const allPages = pages.flatMap(page => {
    const type = types.get(page.content_type ?? 'page');
    const resolved = type ? resolveContentPage(page, type) : null;
    return resolved ? [resolved] : [];
  });
  const livePages = allPages.filter(page => page.status === 'published' || page.status === 'unlisted');
  const drafts = new Map(allPages.filter(page => page.status !== 'published' && page.status !== 'unlisted').map(page => [normalizeRoute(page.path!), page.id]));
  for (const page of livePages) routes.add(normalizeRoute(page.path!));
  for (const type of types.values()) {
    const published = pages.filter(page => page.status === 'published' && (page.content_type ?? 'page') === type.id)
      .map(page => ({ ...pageContentValues(page), id: page.id }));
    for (const route of facetRoutes(type, published)) routes.add(normalizeRoute(route.path));
  }

  const internalOrigins = new Set(
    Object.values(publicUrlsFor(args.site))
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => { try { return [new URL(value).origin]; } catch { return []; } }),
  );
  if (args.site.domain) internalOrigins.add(`https://${args.site.domain}`);
  for (const entry of media) {
    try {
      const url = new URL(entry.cdn_url);
      if (internalOrigins.has(url.origin)) routes.add(normalizeRoute(url.pathname));
    } catch { /* malformed media URLs are reported by media validation */ }
  }

  const sources: LinkSource[] = [];
  for (const page of allPages) {
    sources.push({
      label: `page:${page.id}`,
      value: { body: contentOf(page), fields: page.fields },
      basePath: applyTrailingSlash(pageUrlFromDoc(page), trailingSlash),
      page,
    });
  }
  for (const partial of partials.filter((entry) => entry.status === 'published')) {
    sources.push({ label: `partial:${partial.id}`, value: contentOf(partial), basePath: '/' });
  }
  for (const template of templates.filter((entry) => entry.status === 'published')) {
    sources.push({ label: `template:${template.id}`, value: template.blocks, basePath: '/' });
  }
  // Menu addresses are checked like any other href; page items below.
  for (const menu of menus) sources.push({ label: `menu:${menu.id}`, value: urlItems(menu.items), basePath: '/' });
  const sortedRedirects = sortRedirectsForEmit(redirects);
  const broken: BrokenInternalLink[] = [];
  const unpublished: InternalLinkReport['unpublished_targets'] = [];
  let checkedLinks = 0;
  let validLinks = 0;
  let redirectedLinks = 0;
  const unique = new Set<string>();
  const links: Array<{ from: string; path: string }> = [];
  // Fragment targets: live Pages by route, each rendered once on first use.
  const pagesByRoute = new Map(livePages.map(page => [normalizeRoute(page.path!), page]));
  const anchorsOf = checkFragments ? createPageAnchorIndex({
    pages, contentTypes, templates, partials, blockTypes, menus, settings, siteFields: siteFields ?? { groups: [], values: {} },
  }) : null;
  const missingFragment = (target: Page | undefined, fragment: string | null): boolean => {
    if (!anchorsOf || !target || fragment === null) return false;
    const ids = anchorsOf(target);
    return ids !== null && !fragmentResolves(fragment, ids);
  };
  for (const source of sources) {
    for (const href of new Set(extractHrefs(source.value))) {
      const fragment = fragmentOf(href);
      // A bare `#x` points into the Page that contains it. Partials, templates
      // and menus appear on many Pages, so only Page bodies are checked here.
      if (href.trim().startsWith('#')) {
        // `#` alone is a placeholder that scrolls to the top; `#{{…}}` is a binding.
        if (!source.page || !anchorsOf || !fragment || fragment.includes('{')) continue;
        const path = normalizeRoute(source.page.path!);
        checkedLinks++;
        unique.add(path);
        if (missingFragment(source.page, fragment)) broken.push({ from: source.label, href, resolved_path: path, reason: 'missing_fragment', fragment });
        else validLinks++;
        continue;
      }
      const parsed = internalPath(href, internalOrigins, source.basePath);
      if (parsed === null) continue;
      checkedLinks++;
      unique.add(parsed);
      if (parsed === '__invalid__') {
        broken.push({ from: source.label, href, resolved_path: href, reason: 'invalid_url' });
        continue;
      }
      const resolved = resolveRoute(parsed, routes, sortedRedirects);
      if (resolved.ok) {
        if (!resolved.redirected && args.includeLinks) links.push({ from: source.label, path: parsed });
        // A redirect keeps the fragment, so it must exist on the final Page.
        if (resolved.path !== null && missingFragment(pagesByRoute.get(resolved.path), fragment)) {
          broken.push({ from: source.label, href, resolved_path: resolved.path, reason: 'missing_fragment', fragment: fragment! });
          continue;
        }
        validLinks++;
        if (resolved.redirected) redirectedLinks++;
      } else if (drafts.has(resolved.path) && ['missing_route','broken_redirect'].includes(resolved.reason)) {
        unpublished.push({ from: source.label, href, resolved_path: resolved.path, page_id: drafts.get(resolved.path)! });
      } else {
        broken.push({ from: source.label, href, resolved_path: resolved.path, reason: resolved.reason });
      }
    }
  }

  // Menu page items link by page id: a deleted page is broken, a page that is
  // not published (menus leave out unlisted pages too) is an unpublished
  // target, and a published page counts as a link to its path
  // (with its children for a page-children item, and every top-level page
  // for a menu that adds new pages automatically).
  const byId = new Map(allPages.map(page => [page.id, page]));
  const listed = (page: Page) => page.status === 'published';
  for (const menu of menus) {
    const from = `menu:${menu.id}`;
    for (const item of pageItems(menu.items)) {
      const id = item.page_id ?? '';
      const page = byId.get(id);
      checkedLinks++;
      if (!page) { broken.push({ from, href: `page:${id}`, resolved_path: '', reason: 'missing_page' }); continue; }
      const path = normalizeRoute(page.path!);
      unique.add(path);
      if (!listed(page)) { unpublished.push({ from, href: `page:${id}`, resolved_path: path, page_id: id }); continue; }
      validLinks++;
      if (!args.includeLinks) continue;
      links.push({ from, path });
      if (item.type === 'children') for (const child of allPages.filter(entry => entry.parent === id && listed(entry))) links.push({ from, path: normalizeRoute(child.path!) });
    }
    if (menu.auto_add_pages && args.includeLinks) {
      for (const page of allPages.filter(entry => !entry.parent && listed(entry) && normalizeRoute(entry.path!) !== '/')) links.push({ from, path: normalizeRoute(page.path!) });
    }
  }

  return {
    checked_links: checkedLinks,
    unique_internal_links: unique.size,
    valid_links: validLinks,
    redirected_links: redirectedLinks,
    broken_links: broken.length,
    broken,
    unpublished_targets: unpublished,
    draft_sources: allPages.filter(page => page.status !== 'published' && page.status !== 'unlisted').map(page => `page:${page.id}`),
    routes: routes.size,
    resources_scanned: sources.length,
    ...(args.includeLinks ? { links } : {}),
  };
}

function flatItems(items: MenuItem[] | undefined): MenuItem[] {
  return (items ?? []).flatMap(item => [item, ...flatItems(item.children)]);
}
/** The address items of a menu, as `{ href }` values for the href scanner. */
function urlItems(items: Menu['items']): Array<{ href: string }> {
  return flatItems(items).filter(item => item.type === 'url' && item.href).map(item => ({ href: item.href! }));
}
function pageItems(items: Menu['items']): MenuItem[] {
  return flatItems(items).filter(item => (item.type === 'page' || item.type === 'children') && item.page_id);
}

function contentOf(doc: Pick<Page | PartialDoc, 'content_mode' | 'html_content' | 'blocks'>): unknown {
  return doc.content_mode === 'blocks' ? doc.blocks : doc.html_content;
}

function extractHrefs(value: unknown): string[] {
  const out: string[] = [];
  const visit = (entry: unknown, key?: string): void => {
    if (key && ['part_styles','style_overrides','style_id','responsive_breakpoints','css','inline_style'].includes(key)) return;
    if (typeof entry === 'string') {
      for (const match of entry.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)) {
        out.push(match[1] ?? match[2] ?? match[3] ?? '');
      }
      if (key && /(?:^href$|^url$|_url$|_href$|^link$|_link$)/iu.test(key)) out.push(entry);
      return;
    }
    if (Array.isArray(entry)) { entry.forEach((value) => visit(value, key)); return; }
    if (entry && typeof entry === 'object') {
      for (const [childKey, value] of Object.entries(entry as Record<string, unknown>)) visit(value, childKey);
    }
  };
  visit(value);
  return out;
}

/** The fragment of an href without `#`, or null when it has none. */
function fragmentOf(href: string): string | null {
  const index = href.indexOf('#');
  return index === -1 ? null : href.slice(index + 1).trim();
}

function internalPath(href: string, origins: Set<string>, basePath: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#') || /^(mailto|tel|sms|javascript|data):/iu.test(raw)) return null;
  if (/\{[{#/]?/u.test(raw)) return null;
  try {
    if (raw.startsWith('/')) {
      if (raw.startsWith('//')) return origins.has(new URL(`https:${raw}`).origin) ? normalizeRoute(new URL(`https:${raw}`).pathname) : null;
      return normalizeRoute(new URL(raw, 'https://internal.invalid').pathname);
    }
    if (/^https?:\/\//iu.test(raw)) {
      const absolute = new URL(raw);
      return origins.has(absolute.origin) ? normalizeRoute(absolute.pathname) : null;
    }
    const relative = new URL(raw, `https://internal.invalid${basePath}`);
    return normalizeRoute(relative.pathname);
  } catch {
    return '__invalid__';
  }
}

function resolveRoute(
  initial: string,
  routes: Set<string>,
  redirects: Redirect[],
): { ok: true; redirected: boolean; path: string | null } | { ok: false; path: string; reason: BrokenInternalLink['reason'] } {
  let path = normalizeRoute(initial);
  if (routes.has(path)) return { ok: true, redirected: false, path };
  const seen = new Set<string>();
  // A redirect that names its own fragment replaces the link's: nothing to check.
  let keepsFragment = true;
  for (let hop = 0; hop < 10; hop++) {
    if (seen.has(path)) return { ok: false, path, reason: 'redirect_loop' };
    seen.add(path);
    let target: string | null = null;
    for (const redirect of redirects) {
      target = matchRedirect(redirect.from_path, redirect.to_path, path);
      if (target !== null) break;
    }
    if (target === null) return { ok: false, path, reason: seen.size > 1 ? 'broken_redirect' : 'missing_route' };
    try {
      const parsed = new URL(target, 'https://internal.invalid');
      if (parsed.origin !== 'https://internal.invalid') return { ok: true, redirected: true, path: null };
      path = normalizeRoute(parsed.pathname);
      if (parsed.hash) keepsFragment = false;
    } catch {
      return { ok: false, path: target, reason: 'broken_redirect' };
    }
    if (routes.has(path)) return { ok: true, redirected: true, path: keepsFragment ? path : null };
  }
  return { ok: false, path, reason: 'redirect_loop' };
}

function normalizeRoute(path: string): string {
  const withoutSlash = path.replace(/\/+$/, '');
  return withoutSlash || '/';
}
