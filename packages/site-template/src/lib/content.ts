// Build-time content fetching. All functions resolve the org+site IDs from
// env vars so call sites don't need to thread them through.

import { applyTrailingSlash, buildCollectionRoutes, collectionFieldMatches, paths, MAIN_VERSION_ID } from '@typeroll/shared';
import type {
  Block,
  BlockType,
  CollectionDef,
  CollectionItem,
  CollectionItemRoute,
  FacetRoute,
  Media,
  Page,
  PageTemplate,
  Partial as PartialDoc,
  Redirect,
  SiteSettings,
  SiteVersion,
} from '@typeroll/shared';
import { defaultSiteSettings } from '@typeroll/shared';
import { getStore } from './datastore.js';

function ids() {
  const orgId = process.env.TYPEROLL_ORG_ID || 'default';
  const siteId = process.env.TYPEROLL_SITE_ID || 'default';
  const versionId = process.env.TYPEROLL_VERSION_ID || MAIN_VERSION_ID;
  return { orgId, siteId, versionId };
}

// ---------------------------------------------------------------------------
// Build-time memoization
//
// `astro build` renders every route in ONE process against a fixtures snapshot
// that materializeFixtures wrote before the build started and nobody touches
// while it runs. A loader's result is therefore invariant for the whole build,
// and re-reading is pure waste.
//
// It was a lot of waste. `[...slug].astro`'s per-page frontmatter calls
// `buildBacklinks()` and `buildCollectionSource()`, and each of those walks
// every collection and loads every item — so every route paid for two full
// dataset loads. That is O(routes × records), i.e. quadratic for a directory
// where the routes ARE the records, and it dominated the per-route cost long
// before sanitisation or block rendering did.
//
// DEV IS DELIBERATELY EXCLUDED. `astro dev` must pick up a fixture edited on
// disk between requests; caching there would serve stale content to someone
// who just saved a file. `import.meta.env.PROD` is true only under
// `astro build`, which is exactly the run where the snapshot is frozen.
const BUILD_CACHE_ENABLED = Boolean(import.meta.env?.PROD);

/** Memoize a no-arg loader for the lifetime of a build. Caches the PROMISE, so
 *  concurrent callers share one read rather than racing to do the same work. */
function buildMemo<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!BUILD_CACHE_ENABLED) return load();
    // A rejected promise must not stay cached — a transient read failure would
    // otherwise fail every remaining route with the same stale error.
    return (pending ??= load().catch((e) => {
      pending = null;
      throw e;
    }));
  };
}

/** Same, keyed by one string argument. */
function buildMemoKeyed<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    if (!BUILD_CACHE_ENABLED) return load(key);
    let pending = cache.get(key);
    if (!pending) {
      pending = load(key).catch((e) => {
        cache.delete(key);
        throw e;
      });
      cache.set(key, pending);
    }
    return pending;
  };
}

/** Drop every build cache. Tests only — a build process never needs this. */
export function _resetBuildCachesForTests(): void {
  getSiteSettings = buildMemo(loadSiteSettings);
  getAppsPublic = buildMemo(loadAppsPublic);
  getExtensionsPublic = buildMemo(loadExtensionsPublic);
  getPartials = buildMemo(loadPartials);
  getAllCollections = buildMemo(loadAllCollections);
  getCollectionItems = buildMemoKeyed(loadCollectionItems);
  getBlockTypes = buildMemo(loadBlockTypes);
  getBlockRegistry = buildMemo(loadBlockRegistry);
  buildBacklinks = buildMemo(loadBacklinks);
  buildCollectionSource = buildMemo(loadCollectionSource);
}
// ---------------------------------------------------------------------------

let _activeVersion: SiteVersion | null | undefined;
/**
 * Load the SiteVersion doc for the version this build is targeting. Memoised
 * so repeated calls (one per page, basically) don't re-hit the store. Returns
 * null on main when there's no SiteVersion doc materialised yet — callers can
 * treat that as "main, robots_blocked=false".
 */
export async function getActiveVersion(): Promise<SiteVersion | null> {
  if (_activeVersion !== undefined) return _activeVersion;
  const { orgId, siteId, versionId } = ids();
  const doc = await getStore().getDoc<SiteVersion>(paths.version(orgId, siteId, versionId));
  _activeVersion = doc ?? null;
  return _activeVersion;
}

/** True when the active build should be hidden from search engines. */
export async function isVersionRobotsBlocked(): Promise<boolean> {
  const v = await getActiveVersion();
  if (!v) return false; // main with no doc — index normally
  if (v.kind === 'main') return Boolean(v.robots_blocked);
  // Branches default to blocked; an explicit `false` lets a customer opt in.
  return v.robots_blocked !== false;
}

async function loadSiteSettings(): Promise<SiteSettings> {
  const { orgId, siteId, versionId } = ids();
  const settings = await getStore().getDoc<SiteSettings>(paths.settings(orgId, siteId, versionId));
  return settings ?? defaultSiteSettings;
}
export let getSiteSettings = buildMemo(loadSiteSettings);

/**
 * The PUBLIC apps snapshot the deploy materialized (enabled apps + their
 * public config only — never secrets). Read at build time so BaseLayout can
 * inject opt-in beacons (analytics, …). Absent doc → no apps enabled.
 */
async function loadAppsPublic(): Promise<import('@typeroll/shared').SiteApps> {
  const { orgId, siteId } = ids();
  const doc = await getStore().getDoc<import('@typeroll/shared').SiteApps>(paths.apps(orgId, siteId));
  return doc ?? { apps: {} };
}
export let getAppsPublic = buildMemo(loadAppsPublic);

async function loadExtensionsPublic(): Promise<import('@typeroll/shared').ExtensionRuntimeSnapshot> {
  const { orgId, siteId } = ids();
  const doc = await getStore().getDoc<import('@typeroll/shared').ExtensionRuntimeSnapshot>(
    paths.extensionRuntimeSnapshot(orgId, siteId),
  );
  return doc ?? { runtime_version: '0.35.0', protocol_version: 1, installations: [] };
}
export let getExtensionsPublic = buildMemo(loadExtensionsPublic);

/**
 * Load every Media doc on this site. Used at build time by the SEO/CWV
 * post-pass on rendered HTML — the transform looks up each `<img src>`
 * by CDN URL to pull width/height (CLS prevention) and variants
 * (AVIF/WebP srcset). Cheap; media docs are small and there's typically
 * <1000 per site.
 *
 * Media lives per-site (not per-version) so this is version-independent.
 */
export async function getAllMedia(): Promise<Media[]> {
  const { orgId, siteId } = ids();
  return getStore().listDocs<Media>(paths.media(orgId, siteId));
}

async function loadPartials(): Promise<{
  header: PartialDoc | null;
  footer: PartialDoc | null;
  freeBlocks: PartialDoc[];
}> {
  const { orgId, siteId, versionId } = ids();
  const list = await getStore().listDocs<PartialDoc>(paths.partials(orgId, siteId, versionId));
  const header = list.find((p) => p.kind === 'header' && p.status === 'published') ?? null;
  const footer = list.find((p) => p.kind === 'footer' && p.status === 'published') ?? null;
  const freeBlocks = list.filter((p) => p.kind === 'free');
  return { header, footer, freeBlocks };
}
export let getPartials = buildMemo(loadPartials);

export async function getAllPages(opts: { includeUnlisted?: boolean } = {}): Promise<Page[]> {
  const { orgId, siteId, versionId } = ids();
  const all = await getStore().listDocs<Page>(paths.pages(orgId, siteId, versionId));
  return all.filter((p) => {
    if (p.status === 'published') return true;
    if (p.status === 'unlisted' && opts.includeUnlisted !== false) return true;
    return false;
  });
}

export async function getRedirects(): Promise<Redirect[]> {
  const { orgId, siteId, versionId } = ids();
  return getStore().listDocs<Redirect>(paths.redirects(orgId, siteId, versionId));
}

export function isHomePage(page: Pick<Page, 'slug' | 'path'>): boolean {
  if (page.path === '/') return true;
  if (page.path !== undefined && page.path !== '/') return false;
  return page.slug === '' || page.slug === '/' || page.slug === 'home' || page.slug === 'index';
}

/**
 * Live URL for a page. When `path` is set, it's the authoritative URL
 * (the C6 follow-up from autopilot.se — nested paths without abusing
 * slug semantics). Otherwise fall back to "/" + slug (or "/" for the
 * homepage), which preserves every existing page's URL unchanged.
 */
export function urlFor(page: Pick<Page, 'slug' | 'path'>, trailingSlash: SiteSettings['trailing_slash'] = 'always'): string {
  if (isHomePage(page)) return '/';
  const raw =
    typeof page.path === 'string' && page.path.length > 0
      ? page.path
      : page.slug;
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return applyTrailingSlash(withLeading, trailingSlash ?? 'always');
}

/**
 * List every collection on the active version. Used by getStaticPaths and
 * sitemap generation to enumerate per-item routes.
 */
async function loadAllCollections(): Promise<CollectionDef[]> {
  const { orgId, siteId, versionId } = ids();
  return getStore().listDocs<CollectionDef>(paths.collections(orgId, siteId, versionId));
}
export let getAllCollections = buildMemo(loadAllCollections);

async function loadCollectionItems(name: string): Promise<CollectionItem[]> {
  const { orgId, siteId, versionId } = ids();
  return getStore().listDocs<CollectionItem>(paths.collectionItems(orgId, siteId, name, versionId));
}
export let getCollectionItems = buildMemoKeyed(loadCollectionItems);

/**
 * Build the full per-item route map for the active version. One entry per
 * published item whose owning collection has a non-empty `route_template`
 * and whose template placeholders all resolve. Drafts + opted-out
 * collections are filtered out.
 */
export async function getCollectionItemRoutes(): Promise<CollectionItemRoute[]> {
  const collections = await getAllCollections();
  const itemsByCollection = new Map<string, CollectionItem[]>();
  for (const c of collections) {
    if (!c.route_template) continue;
    const items = await getCollectionItems(c.name);
    itemsByCollection.set(c.name, items);
  }
  return buildCollectionRoutes(collections, itemsByCollection);
}

/**
 * Coerce any value into a plain string. Used by helpers below.
 * Lives here (not inside [...slug].astro) because Astro v5 hoists
 * `getStaticPaths` into a separate compiled module that can't see
 * top-level helpers from the same .astro file — referencing them
 * from inside getStaticPaths throws `ReferenceError: X is not defined`
 * at build time.
 */
function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

/**
 * Synthesize a Page object from a collection item so BaseLayout (which
 * is Page-shaped) renders metadata correctly. SEO fields fall through
 * item → derived defaults so collection items get reasonable Google
 * previews even without per-item SEO authoring.
 *
 * Exported (and lives here, not in [...slug].astro) so getStaticPaths
 * can reference it across Astro's hoisted-module boundary.
 */
export function pageForItem(
  collection: CollectionDef,
  item: CollectionItem,
  path: string,
): Page {
  const data = item as Record<string, unknown>;
  const title = asString(data.title) || asString(data.name) || collection.label_singular;
  const seoTitle = asString(data.seo_title) || title;
  const seoDescription = asString(data.seo_description) || asString(data.excerpt) || '';
  return {
    id: item.id,
    title,
    slug: path.replace(/^\/+/, ''),
    content_mode: 'html',
    status: 'published',
    seo_title: seoTitle,
    seo_description: seoDescription,
    og_image: asString(data.og_image) || asString(data.image) || undefined,
    kind: 'article',
    date_updated: item.updated_at,
    date_published: asString(data.date_published) || item.created_at,
    html_content: '',
  };
}

function defaultFacetBlocks(collection: CollectionDef, title: string, scope: string): Block[] {
  return [
    {
      id: 'facet-section',
      type: 'core/section',
      data: { width: 'wide' },
      children: [
        { id: 'facet-heading', type: 'core/heading', data: { text: title, level: 'h1', size: '2xl' } },
        { id: 'facet-intro', type: 'core/prose', data: { html: `<p>${escapeText(scope)}</p>` } },
        {
          id: 'facet-list',
          type: 'core/collection_list',
          // No filter_field/filter_value: the block inherits the page's facet
          // scope from the render context.
          data: { collection: collection.name, source_type: 'collection' },
        },
      ],
    } as Block,
  ];
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Synthetic Page for a taxonomy route. Titles read as "Rormokare i Goteborg"
 * would need locale-aware joining we don't have, so the label is built from
 * the facet's own `label_singular` plus the value — predictable, and the
 * operator can override the whole shell with a `template`.
 */
export function pageForFacet(collection: CollectionDef, route: FacetRoute): Page {
  const title = route.filters.map((f) => f.value).join(' · ');
  const scope = route.filters.map((f) => `${f.label_singular}: ${f.value}`).join(', ');
  return {
    id: `facet--${route.path.replace(/[^a-z0-9]+/gi, '-')}`,
    title,
    slug: route.path.replace(/^\/+/, ''),
    content_mode: 'blocks',
    // With a `template` assigned the page's own blocks fill the template's
    // content slot, so an empty tree is right. Without one there'd be
    // nothing on the page at all, so fall back to a heading plus a listing
    // — the listing inherits the facet scope from the render context and
    // needs no per-route configuration.
    blocks: route.template ? [] : defaultFacetBlocks(collection, title, scope),
    status: 'published',
    seo_title: `${title} — ${collection.label_plural}`,
    seo_description: `${collection.label_plural} — ${scope}.`,
    kind: 'page',
    template: route.template,
    html_content: '',
  };
}

/**
 * Load every custom BlockType authored on this site. Merged with the core
 * library at build time so a page that references `user/fancy-card` or
 * `third_party/foo` finds it in the registry. Drafts / unpublished status
 * is irrelevant for block types — every saved type is renderable.
 */
async function loadBlockTypes(): Promise<BlockType[]> {
  const { orgId, siteId, versionId } = ids();
  return getStore().listDocs<BlockType>(paths.blockTypes(orgId, siteId, versionId));
}
export let getBlockTypes = buildMemo(loadBlockTypes);

/**
 * Core block library + every BlockType this site authored or installed,
 * per-site docs winning on collision.
 *
 * Built once per build rather than once per route: `buildCoreBlockRegistry()`
 * constructs ~40 type objects, and the page renderer, the header and the
 * footer each used to build their own copy on every page.
 *
 * The returned Map is SHARED — treat it as read-only. `renderBlocks` only
 * looks types up; a caller that needs to add a type for one route must copy
 * first, or every later route inherits it.
 */
async function loadBlockRegistry(): Promise<Map<string, BlockType>> {
  const { buildCoreBlockRegistry } = await import('@typeroll/shared');
  const registry = buildCoreBlockRegistry();
  for (const bt of await getBlockTypes()) registry.set(bt.id, bt);
  return registry;
}
export let getBlockRegistry = buildMemo(loadBlockRegistry);

/**
 * Rendered + sanitized HTML for a partial, memoized by the partial's own
 * content.
 *
 * Header and Footer are rendered on EVERY route, and both used to re-run the
 * block renderer and sanitize-html each time over byte-identical input. On a
 * 500-route site that is 1000 redundant sanitiser passes.
 *
 * Keyed by content rather than by page, which is what makes per-page variation
 * cheap instead of impossible: two different headers cost two cache entries,
 * not two renders per page. What CANNOT be cached this way is a partial that
 * binds page context — its output genuinely differs per route — so those are
 * detected and rendered normally rather than cached wrong.
 *
 * ⚠️ INVARIANT: the key covers the partial's content, NOT the caller's context.
 * That is sound only while every caller passes an equivalent non-route-varying
 * context — in practice, a `site` slice built the same way. Both callers go
 * through `siteContext()` for exactly that reason. This is not theoretical: an
 * experiment that made 404.astro and [...slug].astro build `site` differently
 * had the 404's render populate the cache and every other page silently reuse
 * it, which masked the very bug the test was checking for.
 */
const partialHtmlCache = new Map<string, string>();

/**
 * Context namespaces whose values differ from one route to the next. `site.*`
 * is deliberately absent: it is the same for every page in a build, so a
 * header using {{site.name}} stays cacheable.
 */
const ROUTE_VARYING_TOKEN = /\{\{\{?\s*(page|item|collection|facet|pagination)\./;

/**
 * Can this partial's output differ between routes?
 *
 * Conservative on purpose — a false "no" produces one route's header on every
 * page, which is a silent content bug, while a false "yes" only costs a
 * re-render. Two independent reasons a partial can vary:
 *
 *  1. A token binding a route-varying namespace. Easy to see in the source.
 *  2. A BLOCK TYPE that reads context without naming it in a token. This is
 *     the one that would have been missed: a repeater with no filter of its
 *     own inherits the facet scope from the render context, so the same
 *     footer listing renders different items on /ort/goteborg/ and
 *     /ort/uppsala/ while containing no {{facet.*}} anywhere. The template/*
 *     family binds context by definition.
 */
async function isRouteVarying(partial: PartialDoc): Promise<boolean> {
  const source = partial.content_mode === 'blocks' && partial.blocks?.length
    ? JSON.stringify(partial.blocks)
    : partial.html_content ?? '';
  if (ROUTE_VARYING_TOKEN.test(source)) return true;
  if (!(partial.content_mode === 'blocks' && partial.blocks?.length)) return false;

  const { collectUsedBlockTypeIds } = await import('@typeroll/shared');
  const registry = await getBlockRegistry();
  for (const id of collectUsedBlockTypeIds(partial.blocks)) {
    if (id.startsWith('template/')) return true;
    // Follow expand_to: the aliases (collection_list, testimonials, …) are
    // repeaters wearing a different name, and they inherit scope identically.
    let entry = registry.get(id);
    if (!entry) return true; // unknown type — assume the worst
    let hops = 5;
    while (entry?.expand_to && hops-- > 0) {
      const next: BlockType | undefined = registry.get(entry.expand_to.target);
      if (!next) break;
      entry = next;
    }
    if (entry?.container === 'repeater') return true;
  }
  return false;
}

export async function renderPartialHtml(
  partial: PartialDoc,
  context?: import('@typeroll/shared').RenderContext,
  directives?: {
    freeBlocks?: PartialDoc[];
    extensionSource?: (
      blockTypeId: string,
    ) => import('@typeroll/shared').ExtensionIncludeDescriptor | undefined;
    iframeAllowedHosts?: string[];
  },
): Promise<string | null> {
  const { expandExtensionIncludes, expandIncludes, renderBlocks } = await import('@typeroll/shared');
  const { sanitizeBody } = await import('./sanitize.js');

  // Expand HTML directives before selecting the cache key. The 404 route is
  // generated before ordinary pages and historically called this helper
  // without directive resolvers, which cached raw <x-extension> markup under
  // the same key later used by fully configured page renders.
  const expandedHtml = partial.html_content
    ? (() => {
        const withIncludes = directives?.freeBlocks
          ? expandIncludes(partial.html_content!, directives.freeBlocks)
          : partial.html_content!;
        return directives?.extensionSource
          ? expandExtensionIncludes(withIncludes, directives.extensionSource)
          : withIncludes;
      })()
    : '';

  const render = async (): Promise<string | null> => {
    if (partial.content_mode === 'blocks' && partial.blocks?.length) {
      // The MERGED registry — core plus this site's own BlockTypes. Partials
      // used to render against the core library alone, so a custom or
      // app-provided block in a header (the directory app's form blocks, for
      // one) silently rendered as nothing on the live site while the portal's
      // preview, which has always used the merged registry, showed it working.
      //
      // Context + collectionSource for the same reason: render-preview.ts
      // passes both to partials, so without them a header bound to
      // {{site.name}} or a footer listing recent posts previewed correctly
      // and shipped empty.
      return sanitizeBody(renderBlocks(partial.blocks, {
        registry: await getBlockRegistry(),
        context,
        collectionSource: await buildCollectionSource(),
        onMissingType: (typeId) => {
          throw new Error(`Cannot build partial with missing block type: ${typeId}`);
        },
      }), directives?.iframeAllowedHosts);
    }
    if (expandedHtml) {
      return sanitizeBody(expandedHtml, directives?.iframeAllowedHosts);
    }
    return null;
  };

  if (!BUILD_CACHE_ENABLED || await isRouteVarying(partial)) return render();

  const key = partial.content_mode === 'blocks' && partial.blocks?.length
    ? `blocks:${partial.id}:${JSON.stringify(partial.blocks)}`
    : `html:${partial.id}:${expandedHtml}:iframes:${JSON.stringify(directives?.iframeAllowedHosts ?? [])}`;
  const hit = partialHtmlCache.get(key);
  if (hit !== undefined) return hit;
  const html = await render();
  if (html !== null) partialHtmlCache.set(key, html);
  return html;
}

/**
 * Pre-load every collection's items into an in-memory cache so the block
 * renderer's `collectionSource` resolver can stay synchronous (the
 * renderer itself isn't async). Returns a sync function the page can pass
 * to `renderBlocks({ collectionSource })`.
 *
 * The resolver applies the repeater's filter/sort/limit at call time so
 * each repeater on a page gets exactly the items it asks for. Pinned
 * IDs land at the front of the result.
 */
/**
 * Reverse reference index over every published item. Uses the same item set
 * buildCollectionSource loads, so this is a pass over data that's in memory
 * either way — never a second read, and never stored.
 */
async function loadBacklinks(): Promise<import('@typeroll/shared').BacklinkIndex> {
  const { buildBacklinkIndex } = await import('@typeroll/shared');
  const collections = await getAllCollections();
  const byName: Record<string, CollectionItem[]> = {};
  for (const c of collections) {
    byName[c.name] = (await getCollectionItems(c.name)).filter((i) => i.status === 'published');
  }
  return buildBacklinkIndex(collections, byName);
}
/** The index is derived purely from stored forward refs, so it is the same for
 *  every route in a build — memoized rather than rebuilt per page. */
export let buildBacklinks = buildMemo(loadBacklinks);

type CollectionSourceConfig = {
  collection: string;
  /** Exactly these items, in this order — the `related`/`backlinks` sources. */
  ids?: string[];
  limit?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  filter_field?: string;
  filter_value?: string;
  pinned_ids?: string[];
};

async function loadCollectionSource(): Promise<
  (config: CollectionSourceConfig) => Record<string, unknown>[]
> {
  const collections = await getAllCollections();
  const byName = new Map<string, CollectionItem[]>();
  const byId = new Map<string, Map<string, CollectionItem>>();
  for (const c of collections) {
    const items = await getCollectionItems(c.name);
    const published = items.filter((i) => i.status === 'published');
    byName.set(c.name, published);
    // Built once instead of per `ids` lookup. A page with a related-items
    // block used to rebuild this map on every render.
    byId.set(c.name, new Map(published.map((i) => [i.id, i])));
  }

  // Filter+sort results, keyed by the QUERY rather than by the caller. A site
  // has a handful of distinct query shapes and potentially thousands of
  // repeater calls (one per listing per route), so this turns a sort of the
  // whole collection per call into one sort per shape.
  const queryCache = new Map<string, CollectionItem[]>();

  return (config) => {
    const base = byName.get(config.collection);
    if (!base) return [];
    // `ids` IS the query for reference-backed sources: return exactly those,
    // in the order given, skipping any that no longer exist. Sort/filter/
    // pagination don't apply — the caller already decided the membership.
    if (config.ids) {
      const index = byId.get(config.collection)!;
      return config.ids
        .map((id) => index.get(id))
        .filter((i): i is CollectionItem => Boolean(i)) as unknown as Record<string, unknown>[];
    }

    const key = [
      config.collection,
      config.filter_field ?? '',
      config.filter_value ?? '',
      config.sort_by ?? '',
      config.sort_order ?? '',
    ].join(' ');

    let resolved = queryCache.get(key);
    if (!resolved) {
      let out: CollectionItem[] = base.slice();
      if (config.filter_field && config.filter_value !== undefined) {
        const f = config.filter_field;
        const v = config.filter_value;
        out = out.filter((it) => collectionFieldMatches(it as Record<string, unknown>, f, v));
      }
      if (config.sort_by) {
        const k = config.sort_by;
        const dir = config.sort_order === 'asc' ? 1 : -1;
        out.sort((a, b) => {
          const av = (a as Record<string, unknown>)[k];
          const bv = (b as Record<string, unknown>)[k];
          if (av == null) return 1;
          if (bv == null) return -1;
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
      }
      resolved = out;
      queryCache.set(key, resolved);
    }

    // `pinned_ids` and `limit` stay OUT of the cache key: they reorder or clip
    // an already-resolved set, and folding them in would multiply the number
    // of cached sorts by the number of pin/limit combinations for no gain.
    let out = resolved;
    if (config.pinned_ids?.length) {
      const pinSet = new Set(config.pinned_ids);
      out = [...out.filter((it) => pinSet.has(it.id)), ...out.filter((it) => !pinSet.has(it.id))];
    }
    if (config.limit && out.length > config.limit) {
      out = out.slice(0, config.limit);
    }
    // Never hand back the cached array itself — a consumer that sorts or
    // splices in place would corrupt every later call sharing this query.
    return (out === resolved ? out.slice() : out) as unknown as Record<string, unknown>[];
  };
}

/** Memoized per build: the resolver closes over the whole published item set,
 *  so rebuilding it per route re-read every collection from disk. */
export let buildCollectionSource = buildMemo(loadCollectionSource);

/**
 * Fetch a page template doc by id. Returns null if the template doesn't
 * exist or isn't published. Build-time: any reference to a missing
 * template silently falls back to no-template rendering (page blocks
 * render directly without a wrapper).
 */
export async function getPageTemplate(templateId: string): Promise<PageTemplate | null> {
  const { orgId, siteId, versionId } = ids();
  const doc = await getStore().getDoc<PageTemplate>(
    paths.pageTemplate(orgId, siteId, templateId, versionId),
  );
  if (!doc) return null;
  if (doc.status !== 'published') return null;
  return doc;
}

/**
 * Forms 2.0: build the formSource resolver for core/form blocks. Form docs
 * arrive in the fixtures pre-enriched by materializeFixtures with
 * submit_url / submit_token / pow_bits (the build itself has no secrets).
 * Returns markup per form id; pages append the runtime once when any form
 * rendered (detect via data-tr-form in the body html).
 */
export async function buildFormSource(
  registry: Map<string, import('@typeroll/shared').BlockType>,
  lang?: string,
): Promise<(formId: string) => string | undefined> {
  const { renderFormHtml } = await import('@typeroll/shared');
  type EnrichedForm = import('@typeroll/shared').Form & {
    submit_url?: string;
    submit_token?: string | null;
    pow_bits?: number;
  };
  let forms: EnrichedForm[] = [];
  try {
    const { orgId, siteId } = ids();
    forms = await getStore().listDocs<EnrichedForm>(paths.forms(orgId, siteId));
  } catch {
    forms = [];
  }
  const byId = new Map(forms.map((f) => [f.id, f]));
  return (formId: string) => {
    const form = byId.get(formId);
    if (!form || (form.steps?.length ?? 0) === 0) return undefined;
    return renderFormHtml(
      form,
      { submit_url: form.submit_url ?? '/api/forms/submit', submit_token: form.submit_token ?? null },
      { registry, pow_bits: form.pow_bits ?? 0, lang },
    );
  };
}
