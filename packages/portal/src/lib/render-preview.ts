// Server-side preview renderer.
//
// Reads a page, settings, and partials from the datastore and produces an HTML
// document that visually matches what the static site will render. The same
// CSS theming approach as the site-template (inline CSS custom properties
// from settings) so the preview looks right.
//
// This is deliberately not the Astro renderer — running Astro for a single
// page on every keystroke would be slow. Instead this lightweight renderer
// produces the same output for HTML-mode pages. When block rendering ships,
// we'll either extend this or call into the site-template build.

import type {
  BlockType,
  CollectionDef,
  CollectionItem,
  Page,
  Partial as PartialDoc,
  RenderContext,
  SiteSettings,
  SiteVersion,
} from '@typeroll/shared';
import { vstore } from './version-store';
import {
  buildCollectionRoutes,
  buildCoreBlockRegistry,
  collectBlockAssets,
  composePageWithTemplate,
  defaultSiteSettings,
  expandExtensionIncludes,
  expandFormIncludes,
  expandIncludes,
  MAIN_VERSION_ID,
  renderBlocks,
  renderItemTemplate,
  siteContext,
} from '@typeroll/shared';
import { getStore } from './datastore';
import { paths } from '@typeroll/shared';
import { sanitizeBody } from './sanitize';
import { listWorkingCopies, overlayWorkingCopy } from './working-copy';
import { editorCanvasBridgeScript } from './editor-canvas-bridge';

// NOTE ON APPS: this renderer deliberately does NOT read the site's apps doc,
// so no third-party tag from the integrations app — and no analytics beacon —
// is emitted here. Previewing your own site must not fire an ad pixel or
// pollute your analytics. This is intentional divergence from BaseLayout, not
// drift to be "fixed".

export interface PreviewOptions {
  /**
   * When set, rewrite internal links (`href="/foo"`) to `{browseRoot}/foo`
   * so the preview iframe / new tab stays inside the preview surface as the
   * user navigates between pages.
   */
  browseRoot?: string;
  /** Appended to every rewritten internal link (e.g. "?embed=1" to keep the
   *  embed mode while navigating inside the editor iframe). */
  embedSuffix?: string;
  /** Show a sticky banner at the top of the preview body. */
  showBanner?: boolean;
  /** Live site URL (for the banner's "Open live" link). */
  liveBase?: string;
  /** Override the page document being rendered. Used by the revision-preview
   *  route so we can render a past snapshot without writing it back. */
  pageOverride?: Page;
  /** Tag every block's root element with `data-block-id` + `data-block-type`
   *  so an agent can map the rendered HTML back to the block to edit. Off by
   *  default; the public preview / deploy never sets it. */
  annotate?: boolean;
  /** Stamp inline-edit spans on text fields in the page body (see
   *  RenderBlocksOptions.editable). Editor iframe only. */
  editable?: boolean;
  /** Overlay editor working copies (unsaved autosaved edits) onto pages,
   *  partials and collection items. ONLY the cookie-auth editor preview
   *  sets this — shared preview links and deploys must never see unsaved
   *  edits. */
  includeWorkingCopies?: boolean;
  /**
   * Emit block JavaScript (per-type `script` + per-instance `script_fields`)
   * into the preview. **Defaults to OFF**, which is the opposite of the
   * published site.
   *
   * Preview HTML renders on the PORTAL's origin, next to the session cookie,
   * so block JS here runs with the viewer's portal authority rather than as
   * an ordinary visitor. The read-only preview surfaces answer that with an
   * opaque-origin sandbox (lib/preview-headers.ts); the editor iframe can't
   * use one because inline editing and block drag-and-drop read
   * `iframe.contentDocument`.
   *
   * So the editor gates on ownership instead: scripts render only when the
   * viewer's own org owns the site (`session.orgId === owner_org_id`). An
   * author previewing their own work sees it run; a shared-in collaborator or
   * a platform operator viewing someone else's site gets the markup without
   * the code, because there the author and the session holder are different
   * people. Fully closing it means moving the editor's DOM access to
   * postMessage — see docs/directory-app-plan.md §7c.
   */
  allowScripts?: boolean;
  /** Enables the authority-free postMessage bridge used by the isolated
   * editor canvas. The id is an unguessable per-frame correlation value. */
  editorCanvasId?: string;
}

export async function renderPreview(
  orgId: string,
  siteId: string,
  pageId: string,
  versionId: string,
  opts: PreviewOptions = {},
): Promise<string | null> {
  const store = getStore();
  let page = opts.pageOverride ?? (await vstore.page(orgId, siteId, versionId, pageId));
  if (!page) return null;

  const settings = (await vstore.settings(orgId, siteId, versionId)) ?? defaultSiteSettings;
  let partials = await vstore.partials(orgId, siteId, versionId);
  if (opts.includeWorkingCopies) {
    const wcs = await listWorkingCopies({ orgId, siteId, versionId });
    if (!opts.pageOverride) {
      page = overlayWorkingCopy(
        page,
        wcs.find((w) => w.kind === 'page' && w.target_id === pageId),
      );
    }
    partials = partials.map((p) =>
      overlayWorkingCopy(p, wcs.find((w) => w.kind === 'partial' && w.target_id === p.id)),
    );
  }
  const header = partials.find((p) => p.kind === 'header' && p.status === 'published');
  const footer = partials.find((p) => p.kind === 'footer' && p.status === 'published');
  const freeBlocks = partials.filter((p) => p.kind === 'free');

  // The preview iframe mirrors the static build's robots stance so users see
  // their branch's noindex banner before deploy.
  let robotsBlocked = false;
  if (versionId !== MAIN_VERSION_ID) {
    const v = await store.getDoc<SiteVersion>(paths.version(orgId, siteId, versionId));
    robotsBlocked = v?.robots_blocked !== false;
  }

  const safe = (s?: string) => (s ? sanitizeBody(s) : '');
  const rewriteIf = (html: string) =>
    opts.browseRoot ? rewriteInternalHrefs(html, opts.browseRoot, opts.embedSuffix ?? '') : html;

  // Block-mode pages render via the shared block renderer. Merge in any
  // custom block_types so user/* and third_party/* blocks resolve. The
  // preview lives inside the editor and must produce visually identical
  // output to the static build — same context, same collection source.
  const blockRegistry = buildCoreBlockRegistry();
  const customBlockTypes = await store.listDocs<BlockType>(
    paths.blockTypes(orgId, siteId, versionId),
  );
  for (const bt of customBlockTypes) blockRegistry.set(bt.id, bt);
  const extensionSource = (blockTypeId: string) => {
    const blockType = blockRegistry.get(blockTypeId);
    return blockType?.extension ? {
      extension_id: blockType.extension.extension_id,
      installation_id: blockType.extension.installation_id,
      component_id: blockType.extension.component_id,
      label: blockType.label,
    } : undefined;
  };

  // Pre-load collection items so collection-backed repeaters work in
  // preview the same way they do at build time.
  const collectionsRaw = await store.listDocs<CollectionDef>(
    paths.collections(orgId, siteId, versionId),
  );
  const itemsByCollection = new Map<string, CollectionItem[]>();
  for (const c of collectionsRaw) {
    const items = await store.listDocs<CollectionItem>(
      paths.collectionItems(orgId, siteId, c.name, versionId),
    );
    itemsByCollection.set(c.name, items.filter((i) => i.status === 'published'));
  }
  const collectionSource = (config: {
    collection: string;
    /** Exactly these items, in this order — the `related`/`backlinks` sources. */
    ids?: string[];
    limit?: number;
    sort_by?: string;
    sort_order?: 'asc' | 'desc';
    filter_field?: string;
    filter_value?: string;
    pinned_ids?: string[];
  }): Record<string, unknown>[] => {
    const base = itemsByCollection.get(config.collection);
    if (!base) return [];
    let out: CollectionItem[] = base.slice();
    if (config.filter_field && config.filter_value !== undefined) {
      const f = config.filter_field, v = config.filter_value;
      out = out.filter((it) => String((it as Record<string, unknown>)[f] ?? '') === v);
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
    if (config.pinned_ids?.length) {
      const pinSet = new Set(config.pinned_ids);
      const pinned = out.filter((it) => pinSet.has(it.id));
      const rest = out.filter((it) => !pinSet.has(it.id));
      out = [...pinned, ...rest];
    }
    if (config.limit && out.length > config.limit) out = out.slice(0, config.limit);
    return out as unknown as Record<string, unknown>[];
  };

  const renderCtx: RenderContext = {
    page: page as unknown as Record<string, unknown>,
    site: siteContext(settings as unknown as Record<string, unknown>),
    // Paginating listings render their first slice in the preview; the
    // pager appears but its /page/N/ links only exist on the deployed
    // site (route generation is the SSG's job).
    pagination: (() => {
      const slug = String((page as { slug?: string }).slug ?? '');
      const path = String((page as { path?: string }).path ?? '') || (slug ? `/${slug}` : '/');
      return { current: 1, base_url: path.endsWith('/') ? path : `${path}/` };
    })(),
  };

  // Forms 2.0 — mirror of [...slug].astro's formSource, with the embed
  // minted live (the portal has the signing secret).
  const formSource = await (async () => {
    const { renderFormHtml } = await import('@typeroll/shared');
    const { formEmbedInfo, POW_BITS, isFormsSigningConfigured } = await import('./forms-signing');
    const { resolveAppFormEndpoint } = await import('./apps/form-endpoint');
    type F = import('@typeroll/shared').Form;
    let forms: F[] = [];
    try { forms = await store.listDocs<F>(paths.forms(orgId, siteId)); } catch { forms = []; }
    const byId = new Map(forms.map((f) => [f.id, f]));
    return (formId: string) => {
      const form = byId.get(formId);
      if (!form || (form.steps?.length ?? 0) === 0) return undefined;
      // Same resolver the deploy runner uses — an app-backed form must
      // preview against the endpoint it will actually ship with.
      const appEndpoint = resolveAppFormEndpoint(form, {
        siteId,
        portalUrl: (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, ''),
      });
      const embed = appEndpoint ?? formEmbedInfo(orgId, siteId, formId);
      return renderFormHtml(form, embed, {
        registry: blockRegistry,
        pow_bits: appEndpoint ? 0 : (isFormsSigningConfigured() ? POW_BITS : 0),
        lang: (settings as { language?: string }).language,
      });
    };
  })();

  const renderPartial = (p: typeof header): string => {
    if (!p) return '';
    if (p.content_mode === 'blocks' && p.blocks?.length) {
      return sanitizeBody(
        renderBlocks(p.blocks, { registry: blockRegistry, context: renderCtx, collectionSource }),
      );
    }
    return safe(p.html_content);
  };
  let bodyHtml = '';
  let blockCss = '';
  let blockJs = '';
  // Mirrors [...slug].astro: blocks-mode bodies get the unconstrained
  // shell (page-content--blocks) so core/section can run full-bleed.
  let blocksBody = false;
  if (page.content_mode === 'html') {
    const expanded = expandExtensionIncludes(
      expandFormIncludes(
        expandIncludes(page.html_content ?? '', freeBlocks),
        formSource,
      ),
      extensionSource,
    );
    bodyHtml = rewriteIf(sanitizeBody(expanded));
  } else if (page.content_mode === 'blocks' && page.blocks?.length) {
    // Apply a page template if assigned — same composition as the
    // static renderer so the preview matches a real build.
    let effectiveBlocks = page.blocks;
    if (page.template) {
      const tpl = await store.getDoc(paths.pageTemplate(orgId, siteId, page.template, versionId));
      const tplBlocks = (tpl as { blocks?: typeof page.blocks } | null)?.blocks;
      if (tplBlocks?.length) {
        effectiveBlocks = composePageWithTemplate(tplBlocks, page.blocks);
      }
    }
    bodyHtml = rewriteIf(sanitizeBody(renderBlocks(effectiveBlocks, {
      registry: blockRegistry,
      context: renderCtx,
      collectionSource,
      formSource,
      annotate: opts.annotate,
      // Inline-edit spans ride with annotation, page body only — partial
      // blocks aren't reachable through the page's blocks route, so
      // stamping them would produce dead editing affordances.
      editable: opts.editable,
    })));
    const assets = collectBlockAssets(effectiveBlocks, blockRegistry, {
      includeScripts: opts.allowScripts === true,
    });
    blockCss = assets.css;
    blockJs = assets.js;
    blocksBody = true;
  }

  if (bodyHtml.includes('data-tr-form')) {
    const { FORMS_RUNTIME_JS, FORM_SHELL_CSS } = await import('@typeroll/shared');
    bodyHtml += `<style>${FORM_SHELL_CSS}</style><script>${FORMS_RUNTIME_JS}</script>`;
  }
  const editorExtensionRuntime = opts.editorCanvasId && bodyHtml.includes('data-tr-extension-installation')
    ? await (await import('./extensions/editor-runtime')).buildExtensionEditorRuntimeScript(orgId, siteId, versionId, opts.editorCanvasId)
    : '';

  return buildHtml({
    page,
    versionId,
    settings,
    headerHtml: rewriteIf(renderPartial(header)),
    footerHtml: rewriteIf(renderPartial(footer)),
    bodyHtml,
    blocksBody,
    blockCss,
    blockJs,
    allowScripts: opts.allowScripts === true,
    editorCanvasId: opts.editorCanvasId,
    editorCanvasInteractive: opts.annotate === true,
    editorExtensionRuntime,
    robotsBlocked,
    banner: opts.showBanner ? {
      versionId,
      pageStatus: page.status,
      pageSlug: page.slug,
      liveUrl: opts.liveBase && page.status === 'published' ? joinUrl(opts.liveBase, page.slug) : null,
      editorUrl: `/app/sites/${siteId}/pages/${page.id}`,
    } : null,
  });
}

/**
 * Resolve a slug path (e.g. "about" or "blog/post-1") against the active
 * version and render. Used by the navigable preview surface — the user
 * clicks links inside the preview and lands on the matching draft/page in
 * the same surface.
 */
export async function renderPreviewBySlug(
  orgId: string,
  siteId: string,
  slugParts: string[],
  versionId: string,
  opts: PreviewOptions = {},
): Promise<string | null> {
  const pages = await vstore.pages(orgId, siteId, versionId);
  const slugPath = slugParts.join('/').replace(/^\/+|\/+$/g, '');
  const norm = (s: string | undefined) => (s ?? '').replace(/^\/+|\/+$/g, '');
  const isHome = slugPath === '' || slugPath === 'home' || slugPath === 'index';
  const pageMatch = isHome
    ? pages.find((p) => {
        const s = norm(p.slug);
        return s === '' || s === 'home' || s === 'index';
      })
    : pages.find((p) => norm(p.slug) === slugPath);
  if (pageMatch) return renderPreview(orgId, siteId, pageMatch.id, versionId, opts);

  // No page matched — check collection items. Same precedence as the
  // static-site renderer: pages always win when both could resolve to
  // the same path. We only get here if no page claimed the slug.
  const itemRoute = await findCollectionItemRoute(orgId, siteId, versionId, slugPath);
  if (itemRoute) {
    return renderPreviewCollectionItem(orgId, siteId, versionId, itemRoute, opts);
  }
  return null;
}

/**
 * Per-item preview by collection + item id, without slug resolution. Used
 * by the /v1/.../preview-link endpoint when an agent wants to preview a
 * specific item it just wrote.
 */
export async function renderPreviewCollectionItemById(
  orgId: string,
  siteId: string,
  versionId: string,
  collectionName: string,
  itemId: string,
  opts: PreviewOptions = {},
): Promise<{ html: string; path: string } | null> {
  const collection = await vstore.collection(orgId, siteId, versionId, collectionName);
  if (!collection) return null;
  const item = await vstore.collectionItem(orgId, siteId, versionId, collectionName, itemId);
  if (!item) return null;
  const routes = buildCollectionRoutes([collection], new Map([[collection.name, [item]]]));
  const route = routes[0];
  if (!route) return null;
  const html = await renderPreviewCollectionItem(orgId, siteId, versionId, route, opts);
  return html ? { html, path: route.path } : null;
}

async function findCollectionItemRoute(
  orgId: string,
  siteId: string,
  versionId: string,
  slugPath: string,
): Promise<{ path: string; collection: CollectionDef; item: CollectionItem } | null> {
  const target = `/${slugPath}`;
  const collections = await vstore.collections(orgId, siteId, versionId);
  // Cheap prefilter: only check collections whose route_template starts
  // with the same first segment as the slug. Saves listing items on every
  // collection just because something else has more.
  const candidates = collections.filter((c) => {
    if (!c.route_template) return false;
    const first = c.route_template.split('/').filter(Boolean)[0] ?? '';
    if (!first || first.startsWith('{')) return true; // wildcard root
    return target.startsWith(`/${first}/`) || target === `/${first}`;
  });
  for (const c of candidates) {
    const items = await vstore.collectionItems(orgId, siteId, versionId, c.name);
    const routes = buildCollectionRoutes([c], new Map([[c.name, items]]));
    const found = routes.find((r) => r.path.replace(/^\/+|\/+$/g, '') === slugPath);
    if (found) return found;
  }
  return null;
}

async function renderPreviewCollectionItem(
  orgId: string,
  siteId: string,
  versionId: string,
  route: { path: string; collection: CollectionDef; item: CollectionItem },
  opts: PreviewOptions,
): Promise<string | null> {
  const settings = (await vstore.settings(orgId, siteId, versionId)) ?? defaultSiteSettings;
  let partials = await vstore.partials(orgId, siteId, versionId);
  if (opts.includeWorkingCopies) {
    const wcs = await listWorkingCopies({ orgId, siteId, versionId });
    partials = partials.map((p) =>
      overlayWorkingCopy(p, wcs.find((w) => w.kind === 'partial' && w.target_id === p.id)),
    );
    route = {
      ...route,
      item: overlayWorkingCopy(
        route.item,
        wcs.find(
          (w) =>
            w.kind === 'item'
            && w.collection === route.collection.name
            && w.target_id === route.item.id,
        ),
      ),
    };
  }
  const header = partials.find((p) => p.kind === 'header' && p.status === 'published');
  const footer = partials.find((p) => p.kind === 'footer' && p.status === 'published');
  const freeBlocks = partials.filter((p) => p.kind === 'free');

  let robotsBlocked = false;
  if (versionId !== MAIN_VERSION_ID) {
    const v = await getStore().getDoc<SiteVersion>(paths.version(orgId, siteId, versionId));
    robotsBlocked = v?.robots_blocked !== false;
  }

  // Block-tree template wins when set; legacy HTML template otherwise.
  // The block path uses the same registry + collectionSource as the
  // page path, with the current item pushed into context so
  // `template/item_*` blocks resolve correctly.
  let bodyHtml: string;
  let blocksBody = false;
  let blockCss = '';
  let blockJs = '';
  if (route.collection.item_template_blocks?.length) {
    const blockRegistry = buildCoreBlockRegistry();
    const customBlockTypes = await getStore().listDocs<BlockType>(
      paths.blockTypes(orgId, siteId, versionId),
    );
    for (const bt of customBlockTypes) blockRegistry.set(bt.id, bt);

    // collection_list etc. inside an item template might still need a
    // resolver, even though the typical "related posts on the blog
    // detail page" pattern is collection-source-driven. Reuse the
    // empty stub here — wiring full multi-collection preview through
    // the item path is heavier than needed for this code site.
    const collectionSource = (): Record<string, unknown>[] => [];

    const itemCtx: RenderContext = {
      page: undefined,
      site: siteContext(settings as unknown as Record<string, unknown>),
      item: route.item as unknown as Record<string, unknown>,
      collection: {
        name: route.collection.name,
        label_singular: route.collection.label_singular,
        label_plural: route.collection.label_plural,
      },
    };
    bodyHtml = sanitizeBody(renderBlocks(route.collection.item_template_blocks, {
      registry: blockRegistry,
      context: itemCtx,
      collectionSource,
    }));
    blocksBody = true;
    const assets = collectBlockAssets(route.collection.item_template_blocks, blockRegistry, {
      includeScripts: opts.allowScripts === true,
    });
    blockCss = assets.css;
    blockJs = assets.js;
  } else {
    const merged = renderItemTemplate(route.collection.item_template_html, route.item);
    bodyHtml = sanitizeBody(expandIncludes(merged, freeBlocks));
  }

  const data = route.item as Record<string, unknown>;
  const title = String(data.title ?? data.name ?? route.collection.label_singular);
  const synthetic: Page = {
    id: route.item.id,
    title,
    slug: route.path.replace(/^\/+/, ''),
    content_mode: 'html',
    status: 'published',
    seo_title: String(data.seo_title ?? title),
    seo_description: String(data.seo_description ?? data.excerpt ?? ''),
    og_image: typeof data.og_image === 'string' ? data.og_image
      : typeof data.image === 'string' ? data.image : undefined,
    kind: 'article',
    date_updated: route.item.updated_at,
    date_published: typeof data.date_published === 'string' ? data.date_published : route.item.created_at,
    html_content: '',
  };

  const rewriteIf = (html: string) =>
    opts.browseRoot ? rewriteInternalHrefs(html, opts.browseRoot, opts.embedSuffix ?? '') : html;
  const safe = (s?: string) => (s ? sanitizeBody(s) : '');
  const editorExtensionRuntime = opts.editorCanvasId && bodyHtml.includes('data-tr-extension-installation')
    ? await (await import('./extensions/editor-runtime')).buildExtensionEditorRuntimeScript(orgId, siteId, versionId, opts.editorCanvasId)
    : '';
  return buildHtml({
    page: synthetic,
    versionId,
    settings,
    headerHtml: rewriteIf(safe(header?.html_content)),
    footerHtml: rewriteIf(safe(footer?.html_content)),
    bodyHtml: rewriteIf(bodyHtml),
    blocksBody,
    blockCss,
    blockJs,
    allowScripts: opts.allowScripts === true,
    editorCanvasId: opts.editorCanvasId,
    editorCanvasInteractive: opts.annotate === true,
    editorExtensionRuntime,
    robotsBlocked,
    banner: opts.showBanner ? {
      versionId,
      pageStatus: 'published',
      pageSlug: synthetic.slug,
      liveUrl: opts.liveBase ? `${opts.liveBase.replace(/\/$/, '')}${route.path}` : null,
      editorUrl: `/app/sites/${siteId}/collections/${route.collection.name}/items/${route.item.id}`,
    } : null,
  });
}

/**
 * Replace `href="/foo"` (and single-quoted variant) with `href="{root}/foo"`.
 * Skips protocol-relative (`//`), absolute, pure-anchor (`#x`), mailto, and
 * tel hrefs. Fragments are preserved and re-attached AFTER the signed-token
 * suffix: `/#ansokan` → `{root}/?t=…#ansokan`. (Regression: the old pattern
 * excluded `#` entirely, so `/#section` hrefs escaped the preview surface
 * and bounced visitors to the portal login.)
 */
function rewriteInternalHrefs(html: string, root: string, suffix: string): string {
  const cleanRoot = root.replace(/\/$/, '');
  return html.replace(
    /href=(?:"(\/[^"]*?)"|'(\/[^']*?)')/g,
    (m, dq, sq) => {
      const href: string = dq ?? sq;
      if (href.startsWith('//')) return m; // protocol-relative
      const hashIdx = href.indexOf('#');
      const path = hashIdx === -1 ? href : href.slice(0, hashIdx);
      const frag = hashIdx === -1 ? '' : href.slice(hashIdx);
      // The suffix is `?t=…`; if the href already carries a query string,
      // join with `&` instead of producing a second `?`.
      const joinedSuffix = path.includes('?') ? `&${suffix.replace(/^\?/, '')}` : suffix;
      return `href="${cleanRoot}${path}${joinedSuffix}${frag}"`;
    },
  );
}

function joinUrl(base: string, slug: string): string {
  const b = base.replace(/\/$/, '');
  const s = (slug ?? '').replace(/^\/+/, '');
  if (!s || s === 'home' || s === 'index') return b + '/';
  return `${b}/${s}`;
}

interface BannerArgs {
  versionId: string;
  pageStatus: Page['status'];
  pageSlug: string;
  liveUrl: string | null;
  editorUrl: string | null;
}

/**
 * Mirror of SEOHead.astro's <title> composition — keep in lockstep or the
 * preview drifts from the live site (an agent setting default_seo_suffix and
 * checking the preview would conclude the setting is broken).
 */
function composePageTitle(page: Page, settings: SiteSettings): string {
  const base = page.seo_title || page.title;
  if (!settings.default_seo_suffix) return base;
  return base.endsWith(settings.default_seo_suffix) ? base : `${base}${settings.default_seo_suffix}`;
}

function buildHtml(args: {
  page: Page;
  versionId: string;
  settings: SiteSettings;
  headerHtml: string;
  footerHtml: string;
  bodyHtml: string;
  /** True when bodyHtml came from renderBlocks — switches the shell to
   *  page-content--blocks (no max-width/padding; sections own geometry). */
  blocksBody?: boolean;
  blockCss?: string;
  blockJs?: string;
  /** False for the editor canvas, which serves `script-src 'none'`. Controls
   *  whether the shell may use markup that depends on JS to work. */
  allowScripts: boolean;
  editorCanvasId?: string;
  editorCanvasInteractive?: boolean;
  editorExtensionRuntime?: string;
  robotsBlocked: boolean;
  banner: BannerArgs | null;
}): string {
  const { page, settings, headerHtml, footerHtml, bodyHtml, blocksBody, blockCss, blockJs, allowScripts, editorCanvasId, editorCanvasInteractive, editorExtensionRuntime, robotsBlocked, banner } = args;
  // Merge with hardcoded defaults so optional fields (surface, text_light,
  // size_base) never produce "undefined" / "undefinedpx" in CSS when a site's
  // settings object was created before those fields were added, or when only
  // some nested fields were patched. Spread first, then per-field defaults
  // (TypeScript ts(2783) flags duplicate literal keys around a spread).
  const c = {
    ...settings.colors,
    surface: settings.colors?.surface ?? '#f8fafc',
    text_light: settings.colors?.text_light ?? '#64748b',
  };
  const f = {
    ...settings.fonts,
    heading: settings.fonts?.heading ?? 'Inter',
    body: settings.fonts?.body ?? 'Inter',
    size_base: settings.fonts?.size_base ?? 16,
  };
  const fontUrl = buildFontUrl(f.heading, f.body);
  const robots = page.noindex || robotsBlocked ? 'noindex,nofollow' : 'index,follow';

  return `<!doctype html>
<html lang="${escapeAttr(page.language || settings.language || 'en')}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(composePageTitle(page, settings))}</title>
<meta name="description" content="${escapeAttr(page.seo_description || settings.default_meta_description || settings.tagline || '')}" />
<meta name="robots" content="${robots}" />
${settings.favicon ? `<link rel="icon" href="${escapeAttr(settings.favicon)}" />` : ''}
${settings.apple_touch_icon ? `<link rel="apple-touch-icon" sizes="180x180" href="${escapeAttr(settings.apple_touch_icon)}" />` : ''}
${fontUrl ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>${
      // The async-CSS pattern flips rel from preload to stylesheet in an
      // inline onload handler. The editor canvas serves `script-src 'none'`,
      // which blocks that handler — and <noscript> doesn't rescue it, since
      // scripting is enabled and merely restricted, so the flip never happens
      // and the site's fonts silently never load. Non-blocking CSS is a
      // public-site optimisation with nothing to buy in an internal editor
      // frame, so there it links the stylesheet directly.
      allowScripts
        ? `<link rel="preload" as="style" href="${escapeAttr(fontUrl)}" onload="this.onload=null;this.rel='stylesheet'"><noscript><link rel="stylesheet" href="${escapeAttr(fontUrl)}"></noscript>`
        : `<link rel="stylesheet" href="${escapeAttr(fontUrl)}">`
    }<style>@font-face{font-family:'tr-fallback';src:local('Arial');size-adjust:107%;ascent-override:90%;descent-override:22%;line-gap-override:0%}</style>` : ''}
<style>
:root{
  --color-primary:${c.primary};
  --color-secondary:${c.secondary};
  --color-accent:${c.accent};
  --color-background:${c.background};
  --color-surface:${c.surface};
  --color-text:${c.text};
  --color-text-light:${c.text_light};
  --font-heading:'${f.heading}';
  --font-body:'${f.body}';
  --font-size-base:${f.size_base}px;
  --spacing-xs:0.25rem; --spacing-sm:0.5rem; --spacing-md:1rem;
  --spacing-lg:2rem;   --spacing-xl:4rem;
  --radius-sm:0.25rem; --radius-md:0.5rem; --radius-lg:1rem;
  --container-medium:1080px;
  /* Mirror site-template responsive baseline — keep in lockstep with
     packages/site-template/src/styles/global.css or the editor preview
     will drift from the live site. */
  --tr-bp-xs:540px; --tr-bp-sm:720px; --tr-bp-md:900px; --tr-bp-lg:1000px;
  --tr-container:1140px; --tr-container-narrow:820px; --tr-container-pad-x:20px;
}
@media (max-width:1000px){:root{--tr-container-pad-x:36px}}
@media (max-width:720px){:root{--tr-container-pad-x:20px}}
.tr-container{width:min(var(--tr-container),calc(100% - var(--tr-container-pad-x)*2));margin-inline:auto}
.tr-container-narrow{width:min(var(--tr-container-narrow),calc(100% - var(--tr-container-pad-x)*2));margin-inline:auto}
.tr-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:2rem}
.tr-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:2rem}
.tr-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:1.5rem}
@media (max-width:1000px){.tr-grid-2.stack-lg,.tr-grid-3.stack-lg,.tr-grid-4.stack-lg,.tr-grid-4:not(.stack-sm):not(.stack-md){grid-template-columns:1fr}}
@media (max-width:900px){.tr-grid-2.stack-md,.tr-grid-3.stack-md,.tr-grid-3:not(.stack-sm):not(.stack-lg){grid-template-columns:1fr}}
@media (max-width:720px){.tr-grid-2.stack-sm,.tr-grid-2:not(.stack-md):not(.stack-lg),.tr-grid-3.stack-sm,.tr-grid-4.stack-sm{grid-template-columns:1fr}}
.tr-grid-prose-sidebar{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.5fr);gap:2rem}
@media (max-width:720px){.tr-grid-prose-sidebar{grid-template-columns:1fr}}
.tr-card-image-left{display:grid;grid-template-columns:200px minmax(0,1fr);align-items:stretch}
.tr-card-image-left > .tr-card-image{width:100%;aspect-ratio:1;object-fit:cover}
@media (max-width:900px){.tr-card-image-left{grid-template-columns:150px minmax(0,1fr)}}
@media (max-width:470px){.tr-card-image-left{grid-template-columns:1fr}}
.tr-card.has-stroke,.tr-callout.has-stroke{border-radius:0}
*,*::before,*::after{box-sizing:border-box}
*{margin:0}
html,body{height:100%}
html{font-size:var(--font-size-base)}
body{font-family:var(--font-body),-apple-system,BlinkMacSystemFont,sans-serif;color:var(--color-text);background:var(--color-background);line-height:1.5;-webkit-font-smoothing:antialiased}
img,svg,video{display:block;max-width:100%;height:auto}
h1,h2,h3,h4,h5,h6{font-family:var(--font-heading),sans-serif;line-height:1.2}
a{color:var(--color-primary)}
.page-content{max-width:var(--container-medium);margin:0 auto;padding:var(--spacing-lg) var(--spacing-md)}
.page-content--blocks{max-width:none;padding:0}
.page-content--blocks > * + *{margin-top:0}
.page-content--blocks > :not(section, style, script){max-width:var(--container-medium);margin-inline:auto;padding-inline:var(--spacing-md)}
.page-content--blocks > :not(section, style, script) + :not(section, style, script){margin-top:var(--spacing-md)}
/* Mirror site-template/global.css — descendant typography defaults at
   specificity 0 so user class rules win. */
:where(.page-content) > * + *{margin-top:var(--spacing-md)}
:where(.page-content) h1{font-size:2.5rem;margin-top:var(--spacing-lg)}
:where(.page-content) h2{font-size:2rem;margin-top:var(--spacing-lg)}
:where(.page-content) h3{font-size:1.5rem;margin-top:var(--spacing-md)}
:where(.page-content) img{border-radius:var(--radius-md);margin:var(--spacing-md) 0}
:where(.page-content) ul,:where(.page-content) ol{padding-left:1.5rem}
:where(.page-content) blockquote{border-left:3px solid var(--color-accent);padding-left:var(--spacing-md);color:var(--color-text-light);font-style:italic}
.tr-banner{
  position:sticky;top:0;z-index:1000;
  display:flex;align-items:center;gap:1rem;
  padding:.5rem 1rem;
  font:500 13px/1.3 -apple-system,BlinkMacSystemFont,'Geist',sans-serif;
  background:#1f1f23;color:#fafafa;
  border-bottom:1px solid #2a2a30;
}
.tr-banner__pip{width:8px;height:8px;border-radius:999px;background:#f6c177;flex-shrink:0}
.tr-banner__meta{color:#a1a1aa;font-weight:400}
.tr-banner__spacer{flex:1}
.tr-banner a{color:#fafafa;text-decoration:underline;text-underline-offset:2px}
.tr-banner a.tr-banner__btn{
  background:#fafafa;color:#1f1f23;
  padding:.25rem .625rem;border-radius:6px;
  text-decoration:none;font-weight:500;
}
.tr-banner a.tr-banner__btn:hover{background:#fff;color:#1f1f23}
${settings.custom_css ?? ''}
</style>
${blockCss ? `<style data-blocks="1">${blockCss}</style>` : ''}
${page.custom_css ? `<style data-page-css="1">${page.custom_css}</style>` : ''}
</head>
<body>
${banner ? renderBanner(banner) : ''}
${headerHtml ? (looksLikeSemanticTag(headerHtml, 'header') ? headerHtml : `<header class="site-header">${headerHtml}</header>`) : ''}
<main class="${blocksBody ? 'page-content page-content--blocks' : 'page-content'}">${bodyHtml}</main>
${footerHtml ? (looksLikeSemanticTag(footerHtml, 'footer') ? footerHtml : `<footer class="site-footer">${footerHtml}</footer>`) : ''}
${blockJs ? `<script data-blocks="1">(function(){var registry={};window.TyperollBlocks={register:function(id,init){registry[id]=init;},init:function(){Object.keys(registry).forEach(function(id){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(function(el){try{registry[id](el,JSON.parse(el.getAttribute('data-block-data')||'{}'));}catch(e){console.error('[block init]',id,e);}});});}};${blockJs};window.TyperollBlocks.init();})();</script>` : ''}
${editorExtensionRuntime ? `<script data-editor-extension-runtime="1">${editorExtensionRuntime}</script>` : ''}
${editorCanvasId ? `<script data-editor-canvas-bridge="1">${editorCanvasBridgeScript(editorCanvasId, editorCanvasInteractive === true)}</script>` : ''}
</body>
</html>`;
}

function renderBanner(b: BannerArgs): string {
  const versionLabel = b.versionId === 'main' ? 'main' : `branch · ${b.versionId}`;
  const live = b.liveUrl ? ` · <a href="${escapeAttr(b.liveUrl)}" target="_blank" rel="noopener">Open live ↗</a>` : '';
  const editor = b.editorUrl
    ? `<a class="tr-banner__btn" href="${escapeAttr(b.editorUrl)}" target="_blank" rel="noopener">Edit ↗</a>`
    : '';
  return `<div class="tr-banner" role="status">
    <span class="tr-banner__pip" aria-hidden></span>
    <span>Preview</span>
    <span class="tr-banner__meta">/${escapeHtml(b.pageSlug)} · ${escapeHtml(b.pageStatus)} · ${escapeHtml(versionLabel)}</span>
    <span class="tr-banner__spacer"></span>
    <span class="tr-banner__meta">Drafts and unpublished edits visible${live}</span>
    ${editor}
  </div>`;
}

function buildFontUrl(heading: string, body: string): string | null {
  const fams = Array.from(new Set([heading, body].filter(Boolean)));
  if (!fams.length) return null;
  return `https://fonts.googleapis.com/css2?${fams
    .map((fam) => `family=${encodeURIComponent(fam)}:wght@400;500;600;700`)
    .join('&')}&display=swap`;
}

/**
 * True when the partial's own HTML already starts with a semantic tag
 * matching `tag` — meaning the outer `<header>` / `<footer>` wrapper
 * the preview renderer adds by default would nest. The check is
 * intentionally permissive (whitespace + comments tolerated, attributes
 * allowed) so a partial body like `<header class="hero">…</header>` is
 * recognized.
 */
function looksLikeSemanticTag(html: string, tag: string): boolean {
  const re = new RegExp(`^\\s*(?:<!--[\\s\\S]*?-->\\s*)*<${tag}(?:\\s|>)`, 'i');
  return re.test(html);
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll('"', '&quot;');
}
