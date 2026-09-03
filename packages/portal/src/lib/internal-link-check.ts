import {
  applyTrailingSlash,
  buildCollectionRoutes,
  facetRoutes,
  matchRedirect,
  paths,
  renderItemTemplate,
  sortRedirectsForEmit,
} from '@typeroll/shared';
import type {
  CollectionDef,
  CollectionItem,
  Media,
  Page,
  Partial as PartialDoc,
  Redirect,
  Site,
} from '@typeroll/shared';
import type { ReadWriteStore } from './datastore';
import { pageUrlFromDoc } from './page-paths';
import { publicUrlsFor } from './site-public-urls';
import { vstore } from './version-store';

export interface BrokenInternalLink {
  from: string;
  href: string;
  resolved_path: string;
  reason: 'missing_route' | 'broken_redirect' | 'redirect_loop' | 'invalid_url';
}

export interface InternalLinkReport {
  checked_links: number;
  unique_internal_links: number;
  valid_links: number;
  redirected_links: number;
  broken_links: number;
  broken: BrokenInternalLink[];
  routes: number;
  resources_scanned: number;
}

interface LinkSource { label: string; value: unknown; basePath: string }

/** Check internal hrefs entirely against the versioned datastore snapshot.
 * No deployed site or network request is needed. */
export async function checkInternalLinks(args: {
  store: ReadWriteStore;
  orgId: string;
  siteId: string;
  versionId: string;
  site: Site & { id: string };
}): Promise<InternalLinkReport> {
  const { store, orgId, siteId, versionId } = args;
  const [pages, partials, collections, templates, redirects, media, settings] = await Promise.all([
    vstore.pages(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    vstore.collections(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.redirects(orgId, siteId, versionId),
    store.listDocs<Media>(paths.media(orgId, siteId)),
    vstore.settings(orgId, siteId, versionId),
  ]);
  const trailingSlash = settings?.trailing_slash ?? 'always';
  const itemsByCollection = new Map<string, CollectionItem[]>();
  for (const collection of collections) {
    itemsByCollection.set(
      collection.name,
      await vstore.collectionItems(orgId, siteId, versionId, collection.name),
    );
  }

  const routes = new Set<string>(['/', '/404.html', '/robots.txt', '/sitemap.xml']);
  const livePages = pages.filter((page) => page.status === 'published' || page.status === 'unlisted');
  for (const page of livePages) routes.add(normalizeRoute(pageUrlFromDoc(page)));
  for (const route of buildCollectionRoutes(collections, itemsByCollection)) {
    routes.add(normalizeRoute(route.path));
  }
  for (const collection of collections) {
    const published = (itemsByCollection.get(collection.name) ?? []).filter((item) => item.status === 'published');
    for (const route of facetRoutes(collection, published)) routes.add(normalizeRoute(route.path));
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
  for (const page of livePages) {
    sources.push({
      label: `page:${page.id}`,
      value: contentOf(page),
      basePath: applyTrailingSlash(pageUrlFromDoc(page), trailingSlash),
    });
  }
  for (const partial of partials.filter((entry) => entry.status === 'published')) {
    sources.push({ label: `partial:${partial.id}`, value: contentOf(partial), basePath: '/' });
  }
  for (const template of templates.filter((entry) => entry.status === 'published')) {
    sources.push({ label: `template:${template.id}`, value: template.blocks, basePath: '/' });
  }
  for (const collection of collections) {
    const publishedItems = (itemsByCollection.get(collection.name) ?? [])
      .filter((entry) => entry.status === 'published');
    if (publishedItems.length === 0) {
      sources.push({
        label: `collection:${collection.name}:template`,
        value: { html: collection.item_template_html, blocks: collection.item_template_blocks },
        basePath: '/',
      });
    }
    for (const item of publishedItems) {
      const itemPath = buildCollectionRoutes(
        [collection],
        new Map([[collection.name, [item]]]),
      )[0]?.path ?? '/';
      sources.push({
        label: `item:${collection.name}/${item.id}`,
        value: {
          fields: schemaValues(collection, item),
          html: renderItemTemplate(collection.item_template_html, item),
          blocks: collection.item_template_blocks,
        },
        basePath: applyTrailingSlash(itemPath, trailingSlash),
      });
    }
  }

  const sortedRedirects = sortRedirectsForEmit(redirects);
  const broken: BrokenInternalLink[] = [];
  let checkedLinks = 0;
  let validLinks = 0;
  let redirectedLinks = 0;
  const unique = new Set<string>();
  for (const source of sources) {
    for (const href of new Set(extractHrefs(source.value))) {
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
        validLinks++;
        if (resolved.redirected) redirectedLinks++;
      } else {
        broken.push({ from: source.label, href, resolved_path: resolved.path, reason: resolved.reason });
      }
    }
  }

  return {
    checked_links: checkedLinks,
    unique_internal_links: unique.size,
    valid_links: validLinks,
    redirected_links: redirectedLinks,
    broken_links: broken.length,
    broken,
    routes: routes.size,
    resources_scanned: sources.length,
  };
}

function contentOf(doc: Pick<Page | PartialDoc, 'content_mode' | 'html_content' | 'blocks'>): unknown {
  return doc.content_mode === 'blocks' ? doc.blocks : doc.html_content;
}

function schemaValues(collection: CollectionDef, item: CollectionItem): Record<string, unknown> {
  return Object.fromEntries(collection.fields.map((field) => [field.name, item[field.name]]));
}

function extractHrefs(value: unknown): string[] {
  const out: string[] = [];
  const visit = (entry: unknown, key?: string): void => {
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
): { ok: true; redirected: boolean } | { ok: false; path: string; reason: BrokenInternalLink['reason'] } {
  let path = normalizeRoute(initial);
  if (routes.has(path)) return { ok: true, redirected: false };
  const seen = new Set<string>();
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
      if (parsed.origin !== 'https://internal.invalid') return { ok: true, redirected: true };
      path = normalizeRoute(parsed.pathname);
    } catch {
      return { ok: false, path: target, reason: 'broken_redirect' };
    }
    if (routes.has(path)) return { ok: true, redirected: true };
  }
  return { ok: false, path, reason: 'redirect_loop' };
}

function normalizeRoute(path: string): string {
  const withoutSlash = path.replace(/\/+$/, '');
  return withoutSlash || '/';
}
