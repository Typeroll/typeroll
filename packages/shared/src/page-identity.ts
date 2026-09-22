// What a built page says about itself, in its markup.
//
// A stylesheet could not tell the home page from an article, or one content
// type from another: `<body>` was emitted bare and `<main>` carried only
// `page-content`. Everything the renderer knew about the page it was rendering
// was discarded before the HTML reached the browser, so varying anything by
// route meant either duplicating a whole block tree behind visibility branches
// or writing a selector against a class that happened to survive a migration.
//
// These are a CONTRACT, not an implementation detail. The moment a customer
// styles against them, renaming one breaks their site — so they are documented,
// and they are added to rather than reshaped.
//
// ABSENT AND EMPTY ARE DIFFERENT. A page with no template omits the attribute
// rather than emitting an empty one, so `[data-template]` means "has a
// template" and never matches a page without one. The same construction as the
// handoff packet's optional parts: a value that is not known is not written.

export interface PageIdentityInput {
  /** The page being rendered. */
  page: {
    id?: string;
    path?: string;
    content_type?: string;
    template?: string | null;
  };
  /** Taxonomy scope, on a generated facet route. */
  facet?: { field?: string; value?: string };
  /** 1-based pagination slice, when this URL is a numbered page. */
  pageNum?: number;
  /** The content type id that means "an ordinary page" rather than an item. */
  defaultContentType?: string;
}

/**
 * The route kinds a build can honestly distinguish.
 *
 * Deliberately not a WordPress-shaped list. `archive` is absent because
 * nothing in a built page reliably identifies one — a listing is a block
 * inside an ordinary page, not a route kind — and emitting a guess would be
 * worse than emitting nothing, because a stylesheet would then be written
 * against it.
 */
export type RouteKind = 'home' | 'facet' | 'item' | 'page';

export function routeKind(input: PageIdentityInput): RouteKind {
  if (input.facet) return 'facet';
  const path = input.page.path ?? '';
  if (path === '/' || path === '' || input.page.id === 'home') return 'home';
  const type = input.page.content_type ?? (input.defaultContentType ?? 'page');
  return type !== (input.defaultContentType ?? 'page') ? 'item' : 'page';
}

/** Depth below the site root: `/` is 0, `/guides/` is 1, `/guides/a/` is 2. */
export function routeDepth(path: string | undefined): number {
  return (path ?? '/').split('/').filter(Boolean).length;
}

/**
 * The `data-*` attributes a built page carries on `<body>`.
 *
 * Every value is written only when known. A caller spreads the result, so an
 * attribute that is not in the object is not in the markup.
 */
export function pageIdentityAttributes(input: PageIdentityInput): Record<string, string> {
  const attributes: Record<string, string> = { 'data-route': routeKind(input) };
  const put = (name: string, value: unknown) => {
    if (typeof value === 'string' && value) attributes[name] = value;
  };
  put('data-page', input.page.id);
  put('data-content-type', input.page.content_type);
  put('data-template', input.page.template ?? undefined);
  put('data-facet-field', input.facet?.field);
  put('data-facet-value', input.facet?.value);
  attributes['data-depth'] = String(routeDepth(input.page.path));
  // Only on a numbered slice. Page 1 is the page's own URL and carries no
  // number, so `[data-page-number]` means "this is not the first page".
  if (typeof input.pageNum === 'number' && input.pageNum > 1) {
    attributes['data-page-number'] = String(input.pageNum);
  }
  return attributes;
}
