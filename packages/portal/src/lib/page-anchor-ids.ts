import {
  COOKIE_SETTINGS_FRAGMENT,
  buildCoreBlockRegistry,
  composePageWithTemplate,
  countBlockH1s,
  createPageSource,
  demoteBodyH1s,
  expandIncludes,
  globalBlockSourceFromPartials,
  normalizePageH1s,
  pageContentValues,
  prepareHeadingOutline,
  publicContentPage,
  renderBlocks,
  resolveRenderVersion,
  routeKind,
  siteContext,
} from '@typeroll/shared';
import type {
  BlockType,
  ContentType,
  Menu,
  Page,
  PageTemplate,
  Partial as PartialDoc,
  RenderContext,
  SiteFields,
  SiteSettings,
} from '@typeroll/shared';
import { sanitizeBody } from './sanitize';

/**
 * Fragment targets of a Page as it is published: every `id` in its header,
 * body and footer after the same rendering, sanitizing and heading-id pass
 * the build uses (`prepareHeadingOutline` generates the missing heading ids),
 * plus `<a name>` anchors that survive sanitizing. Each Page renders at most
 * once; the header and footer render once for all Pages.
 */
export function createPageAnchorIndex(input: {
  pages: Page[];
  contentTypes: ContentType[];
  templates: PageTemplate[];
  partials: PartialDoc[];
  blockTypes: BlockType[];
  menus: Menu[];
  settings: SiteSettings | null;
  siteFields: SiteFields;
}): (page: Page) => Set<string> | null {
  const settings = input.settings ?? ({} as SiteSettings);
  const renderVersion = resolveRenderVersion(settings.render_version);
  const allowedHosts = settings.iframe_allowed_hosts;
  const registry = buildCoreBlockRegistry();
  for (const type of input.blockTypes) registry.set(type.id, type);
  const freeBlocks = input.partials.filter(partial => partial.kind === 'free');
  const globalBlockSource = globalBlockSourceFromPartials(freeBlocks);
  const pageSource = createPageSource(input.contentTypes, input.pages, settings.trailing_slash ?? 'always');
  const menuSource = { menus: input.menus };
  const types = new Map(input.contentTypes.map(type => [type.id, type]));
  const templates = new Map(input.templates.map(template => [template.id, template]));
  const site = siteContext(settings as unknown as Record<string, unknown>, undefined, input.siteFields);
  const options = { registry, pageSource, menuSource, renderVersion, globalBlockSource, siteFieldDefinitions: input.siteFields.groups };

  const renderPartial = (kind: 'header' | 'footer', context: RenderContext): string => {
    const partial = input.partials.find(entry => entry.kind === kind && entry.status === 'published');
    if (!partial) return '';
    if (partial.content_mode === 'blocks') return sanitizeBody(renderBlocks(partial.blocks ?? [], { ...options, context }), allowedHosts);
    return sanitizeBody(expandIncludes(partial.html_content ?? '', freeBlocks), allowedHosts);
  };
  let shared: Set<string> | null = null;
  const cache = new Map<string, Set<string> | null>();

  return (page) => {
    if (cache.has(page.id)) return cache.get(page.id)!;
    let ids: Set<string> | null;
    try {
      const type = types.get(page.content_type ?? 'page');
      const context: RenderContext = {
        route: routeKind({ page, defaultContentType: 'page' }),
        content_type: type as unknown as Record<string, unknown>,
        page: pageContentValues(type ? publicContentPage(page, type) : page),
        site,
      };
      let body = '';
      if (page.content_mode === 'blocks') {
        const templateBlocks = (page.template ? templates.get(page.template)?.blocks : undefined) ?? [];
        const pageBlocks = countBlockH1s(templateBlocks) ? demoteBodyH1s(page.blocks ?? []) : page.blocks ?? [];
        const blocks = templateBlocks.length ? composePageWithTemplate(templateBlocks, pageBlocks) : pageBlocks;
        body = sanitizeBody(renderBlocks(blocks, { ...options, context: { ...context, page: { ...context.page, blocks: pageBlocks } } }), allowedHosts);
      } else {
        body = sanitizeBody(expandIncludes(page.html_content ?? '', freeBlocks), allowedHosts);
      }
      body = prepareHeadingOutline(normalizePageH1s(body)).html;
      shared ??= anchorIds(`${renderPartial('header', context)}${renderPartial('footer', context)}`);
      ids = new Set([...shared, ...anchorIds(body)]);
    } catch {
      // A Page that cannot render here is not judged: no false missing fragments.
      ids = null;
    }
    cache.set(page.id, ids);
    return ids;
  };
}

const ID_ATTR = /<[a-z][\w:-]*\s[^>]*?(?<![\w:-])id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;
const NAME_ANCHOR = /<a\s[^>]*?(?<![\w:-])name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;

/** The `id` values of rendered HTML and the names of its `<a name>` anchors. */
export function anchorIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const pattern of [ID_ATTR, NAME_ANCHOR]) {
    for (const match of html.matchAll(pattern)) {
      const value = decodeAttribute(match[1] ?? match[2] ?? match[3] ?? '');
      if (value) ids.add(value);
    }
  }
  return ids;
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (whole, hex: string) => codePoint(Number.parseInt(hex, 16), whole))
    .replace(/&#(\d+);/gu, (whole, dec: string) => codePoint(Number.parseInt(dec, 10), whole))
    .replace(/&(amp|lt|gt|quot|apos);/giu, (_whole, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()]!);
}

function codePoint(value: number, fallback: string): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

/**
 * Whether a URL fragment scrolls somewhere on a Page with these ids, as a
 * browser decides: the empty fragment and `top` scroll to the top; otherwise
 * the raw or percent-decoded fragment must equal an id. `#cookie-settings`
 * opens the cookie banner instead of scrolling, so it always resolves.
 */
export function fragmentResolves(fragment: string, ids: Set<string>): boolean {
  if (fragment === '' || ids.has(fragment)) return true;
  let decoded = fragment;
  try { decoded = decodeURIComponent(fragment); } catch { /* keep the raw fragment */ }
  if (ids.has(decoded)) return true;
  return decoded.toLowerCase() === 'top' || decoded === COOKIE_SETTINGS_FRAGMENT;
}
