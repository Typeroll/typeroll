import { selectChangedRoutes } from './publication-route-cache.mjs';
import { buildBacklinks, buildPageSource, getAllPages, getSiteSettings, getContentTypes, getBlockTypes, getPageTemplate, getPages, pageForFacet, isHomePage, urlFor } from './content';
import { pageNavigation, buildCoreBlockRegistry, composePageWithTemplate, findPaginatedListing, facetRoutes, pageBreadcrumbs, pageContentValues } from '@typeroll/shared';
import type { Block, FacetRoute, Page } from '@typeroll/shared';

// A taxonomy page IS a page — synthetic Page doc, optional PageTemplate,
// same block pipeline. It only differs in carrying a facet scope that
// listing blocks inherit, so it rides PageProps rather than forking the
// renderer into a third branch.
export type PageProps = { page: Page; breadcrumbs: ReturnType<typeof pageBreadcrumbs>; pageNum?: number; facet?: FacetRoute };


export async function getSiteRoutes() {
  const pages = await getAllPages({ includeUnlisted: true });
  const routeSettings = await getSiteSettings();
  const routeTypes = await getContentTypes();
  // urlFor honours the optional `path` field (C6 nested-URL support),
  // falling back to "/" + slug. Strip the leading slash for Astro's
  // `[...slug]` rest-param.
  const pageRoutes = pages.map((page) => ({
    params: { slug: isHomePage(page) ? undefined : urlFor(page, routeSettings.trailing_slash).replace(/^\/+|\/+$/g, '') },
    props: { page, breadcrumbs: pageBreadcrumbs(page, pages, routeSettings.trailing_slash ?? 'always', routeTypes.find(type => type.id === page.content_type)) },
  }));

  // Archive pagination: a page whose block tree holds a collection listing
  // with `paginate` set gets /page/2/, /page/3/… sibling routes. The
  // repeater slices per page and renders the pager; this only decides HOW
  // MANY pages exist (same item query the renderer runs).
  const occupied = new Set(pageRoutes.map(route => route.params.slug ?? ''));
  const archiveRegistry = buildCoreBlockRegistry();
  for (const bt of await getBlockTypes()) archiveRegistry.set(bt.id, bt);
  const archiveSource = await buildPageSource();
  const archiveRoutes: Array<{ params: { slug: string }; props: PageProps }> = [];
  for (const page of pages) {
    if (page.content_mode !== 'blocks' || !page.blocks?.length) continue;
    let effectiveBlocks: Block[] = page.blocks;
    if (page.template) {
      const tpl = await getPageTemplate(page.template);
      if (tpl?.blocks?.length) effectiveBlocks = composePageWithTemplate(tpl.blocks, page.blocks);
    }
    const listing = findPaginatedListing(effectiveBlocks, archiveRegistry);
    if (!listing) continue;
    const total = archiveSource({
      content_type: listing.content_type,
      sort_by: listing.sort_by,
      sort_order: listing.sort_order,
      filter_field: listing.filter_field,
      filter_value: listing.filter_value,
    }).length;
    const totalPages = Math.ceil(total / listing.per_page);
    const base = isHomePage(page) ? '' : `${urlFor(page, routeSettings.trailing_slash).replace(/^\/+|\/+$/g, '')}/`;
    for (let n = 2; n <= totalPages; n++) {
      const slug = `${base}page/${n}`;
      if (occupied.has(slug)) continue;
      occupied.add(slug);
      archiveRoutes.push({
        params: { slug },
        props: { page, breadcrumbs: pageBreadcrumbs(page, pages, routeSettings.trailing_slash ?? 'always', routeTypes.find(type => type.id === page.content_type)), pageNum: n },
      });
    }
  }

  const reservedSlugs = new Set([...pageRoutes, ...archiveRoutes].map(route => route.params.slug ?? ''));

  // Taxonomy pages. Generated per collection from its declared facets; the
  // min_items filters by record count; editorial quality remains a separate decision.
  const facetEntries: Array<{ params: { slug: string }; props: PageProps }> = [];
  for (const coll of [...routeTypes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!coll.facets?.length) continue;
    const published = (await getPages()).filter(page => page.content_type === coll.id && page.status === 'published').map(page => ({ ...pageContentValues(page), id: page.id }));
    for (const route of facetRoutes(coll, published)) {
      const slug = route.path.replace(/^\/+|\/+$/g, '');
      // Real pages and collection items always win a path collision, same
      // rule that already protects item routes.
      if (reservedSlugs.has(slug)) continue;
      reservedSlugs.add(slug);
      facetEntries.push({
        params: { slug },
        props: {
          page: pageForFacet(coll, route),
          breadcrumbs: [{ label: route.filters.map((filter) => filter.value).join(' / '), href: route.path, current: true }],
          facet: route,
        },
      });
    }
  }

  return [...pageRoutes, ...archiveRoutes, ...facetEntries];
}

/** Only the page renderer uses this filter; sitemap keeps the complete inventory. */
export async function getChangedSiteRoutes() {
  const routes = await getSiteRoutes();
  if (!process.env.TYPEROLL_RENDER_CACHE_WORK) return routes;
  const pages = await getAllPages();
  const types = await getContentTypes();
  const settings = await getSiteSettings();
  return selectChangedRoutes(routes, {
    query: await buildPageSource(), backlinks: await buildBacklinks(),
    navigation: (id: string) => {
      const page = routes.find(route => route.props.page.id === id)?.props.page;
      const type = page && types.find(type => type.id === (page.content_type ?? 'page'));
      return page && type ? pageNavigation(page, type, pages, settings.trailing_slash) : {};
    },
  }, settings.trailing_slash);
}
