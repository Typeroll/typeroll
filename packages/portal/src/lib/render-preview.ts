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

import { isContentDeployed, pagePathSegment } from './site-urls';
import type {
  Block,
  Page,
  RenderContext,
  SiteSettings,
  Site,
  SiteVersion,
} from '@typeroll/shared';
import { vstore } from './version-store';
import {
  CONTENT_WELL_CSS, fontFamilyCss, isSystemFont,
  pageRobots,
  breadcrumbJsonLd,
  applyTrailingSlash,
  buildContentPageSchema,
  buildPageSchema,
  buildConsentEarlyPaintRuntime,
  buildCoreBlockRegistry,
  collectBlockAssets,
  composePageWithTemplate,
  defaultSiteSettings,
  expandExtensionIncludes,
  expandFormIncludes,
  expandIncludes,
  MAIN_VERSION_ID,
  renderBlocks,
  renderCookieConsent,
  createPageSource,
  DEFAULT_CONTENT_TYPE,
  contentPagePath,
  resolveContentPage,
  pageNavigation,
  buildBacklinkIndex,
  normalizePageH1s,
  countBlockH1s,
  demoteBodyH1s,
  prepareHeadingOutline,
  pageBodyContext,
  pageContentValues,
  publicContentPage,
  DEFAULT_COOKIE_CONSENT_TEXT,
  pageBreadcrumbs,
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
  /** Shared previews use revocable media routes instead of embedding short-lived read URLs. */
  sharedMediaToken?: string;
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
  deployedVersion?: SiteVersion | null;
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
  /** Connects an opaque, navigable preview document to its inert parent shell
   * for site navigation and tab-scoped Extension storage. */
  extensionPreviewBridge?: { id: string; parentOrigin: string };
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

  const rewriteIf = (html: string) =>
    opts.browseRoot ? rewriteInternalHrefs(html, opts.browseRoot, opts.embedSuffix ?? '') : html;

  // Block-mode pages render via the shared block renderer. Merge in any
  // custom block_types so user/* and third_party/* blocks resolve. The
  // preview lives inside the editor and must produce visually identical
  // output to the static build — same context, same collection source.
  const blockRegistry = buildCoreBlockRegistry();
  const customBlockTypes = await vstore.blockTypes(orgId, siteId, versionId);
  for (const bt of customBlockTypes) blockRegistry.set(bt.id, bt);
  const onMissingType = (typeId: string) =>
    `<div data-tr-missing-block="${escapeHtml(typeId)}" role="alert" style="padding:1rem;border:2px dashed #c53030;color:#742a2a;background:#fff5f5">Missing block type: ${escapeHtml(typeId)}</div>`;
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
  const contentTypes = await vstore.contentTypes(orgId, siteId, versionId);
  const previewPages = await vstore.pages(orgId, siteId, versionId);
  const pageSource = createPageSource(contentTypes, previewPages, settings.trailing_slash ?? 'always');
  const contentType = contentTypes.find(type => type.id === (page!.content_type ?? 'page'))
    ?? ((page.content_type ?? 'page') === 'page' ? DEFAULT_CONTENT_TYPE : null);
  if (!contentType) throw new Error(`Unknown content type: ${page.content_type}`);
  page = resolveContentPage(page, contentType) ?? { ...page, template: page.template || contentType.template };


  const siteForSeo = await store.getDoc<Site>(paths.site(orgId, siteId));
  const seoBase = siteForSeo?.domain ? `https://${siteForSeo.domain}` : opts.liveBase;
  const breadcrumbPages = previewPages.map(candidate => {
    const type = contentTypes.find(type => type.id === (candidate.content_type ?? 'page')) ?? DEFAULT_CONTENT_TYPE;
    return resolveContentPage(candidate, type) ?? candidate;
  });
  const breadcrumbs = pageBreadcrumbs(page, breadcrumbPages, settings.trailing_slash ?? 'always', contentType);
  const renderCtx: RenderContext = {
    content_type: { ...contentType, ...pageNavigation(page, contentType, previewPages, settings.trailing_slash) },
    backlinks: buildBacklinkIndex(contentTypes, previewPages.filter(candidate => candidate.status === 'published')),
    page: {
      ...pageContentValues(publicContentPage(page, contentType)),
      breadcrumbs,
    },
    site: siteContext(settings as unknown as Record<string, unknown>),
    // Paginating listings render their first slice in the preview; the
    // pager appears but its /page/N/ links only exist on the deployed
    // site (route generation is the SSG's job).
    pagination: (() => {
      const slug = String((page as { slug?: string }).slug ?? '');
      const path = String((page as { path?: string }).path ?? '') || (slug ? `/${slug}` : '/');
      return {
        current: 1,
        base_url: path.endsWith('/') ? path : `${path}/`,
        trailing_slash: settings.trailing_slash ?? 'always',
      };
    })(),
  };

  // Forms 2.0 — mirror of [...slug].astro's formSource, with the embed
  // minted live (the portal has the signing secret).
  const assetBlocks: Block[] = [
    ...(header?.content_mode === 'blocks' ? header.blocks ?? [] : []),
    ...(footer?.content_mode === 'blocks' ? footer.blocks ?? [] : []),
  ];
  const formSource = await previewFormSource(orgId, siteId, blockRegistry, settings, assetBlocks);

  const renderPartial = (p: typeof header): string => {
    if (!p) return '';
    if (p.content_mode === 'blocks' && p.blocks?.length) {
      return sanitizeBody(
        renderBlocks(p.blocks, { registry: blockRegistry, context: renderCtx, pageSource, onMissingType }),
        settings.iframe_allowed_hosts,
      );
    }
    const expanded = expandExtensionIncludes(
      expandIncludes(p.html_content ?? '', freeBlocks),
      extensionSource,
    );
    return sanitizeBody(expanded, settings.iframe_allowed_hosts);
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
    bodyHtml = rewriteIf(sanitizeBody(expanded, settings.iframe_allowed_hosts));
  } else if (page.content_mode === 'blocks') {
    const tpl = page.template ? await vstore.pageTemplate(orgId, siteId, versionId, page.template) : null;
    const templateBlocks = tpl?.blocks ?? [];
    const pageBlocks = countBlockH1s(templateBlocks) ? demoteBodyH1s(page.blocks ?? []) : page.blocks ?? [];
    renderCtx.page = { ...renderCtx.page, blocks: pageBlocks };
    // Normalize before deriving the outline so demoted headings retain TOC links.
    renderCtx.page = { ...renderCtx.page, ...pageBodyContext(normalizePageH1s(sanitizeBody(renderBlocks(pageBlocks, {
      registry: blockRegistry, context: renderCtx, pageSource, formSource, onMissingType,
    }), settings.iframe_allowed_hosts), !countBlockH1s(templateBlocks))) };
    const effectiveBlocks = templateBlocks.length
      ? composePageWithTemplate(templateBlocks, pageBlocks) : pageBlocks;
    bodyHtml = rewriteIf(sanitizeBody(renderBlocks(effectiveBlocks, {
      registry: blockRegistry,
      context: renderCtx,
      pageSource,
      formSource,
      onMissingType,
      annotate: opts.annotate,
      // Inline-edit spans ride with annotation, page body only — partial
      // blocks aren't reachable through the page's blocks route, so
      // stamping them would produce dead editing affordances.
      editable: opts.editable,
    }), settings.iframe_allowed_hosts));
    assetBlocks.push(...effectiveBlocks);
    blocksBody = true;
  }

  bodyHtml = prepareHeadingOutline(normalizePageH1s(bodyHtml)).html;
  if (bodyHtml.includes('data-tr-form')) {
    const { FORMS_RUNTIME_JS, FORM_SHELL_CSS } = await import('@typeroll/shared');
    bodyHtml += `<style>${FORM_SHELL_CSS}</style><script>${FORMS_RUNTIME_JS}</script>`;
  }
  const headerHtml = rewriteIf(renderPartial(header));
  const footerHtml = rewriteIf(renderPartial(footer));
  const assets = collectBlockAssets(assetBlocks, blockRegistry, {
    includeScripts: opts.allowScripts === true,
  });
  blockCss = assets.css;
  blockJs = assets.js;
  const mountedHtml = `${headerHtml}${bodyHtml}${footerHtml}`;
  const editorExtensionRuntime = opts.editorCanvasId && mountedHtml.includes('data-tr-extension-installation')
    ? await (await import('./extensions/editor-runtime')).buildExtensionEditorRuntimeScript(orgId, siteId, versionId, opts.editorCanvasId)
    : '';
  const extensionRuntime = !opts.editorCanvasId && opts.allowScripts === true
    && mountedHtml.includes('data-tr-extension-installation')
    ? await (await import('./extensions/preview-runtime')).buildExtensionPreviewRuntimeScript(orgId, siteId, {
        ...(opts.browseRoot
          ? { site_navigation: { base_path: opts.browseRoot, suffix: opts.embedSuffix } }
          : {}),
        ...(opts.extensionPreviewBridge
          ? {
              preview_bridge: {
                id: opts.extensionPreviewBridge.id,
                parent_origin: opts.extensionPreviewBridge.parentOrigin,
              },
            }
          : {}),
      })
    : '';
  const previewNavigationBridge = buildPreviewNavigationBridgeScript(opts);
  const cookieConsentHtml = opts.allowScripts === true
    ? rewriteIf(renderPreviewCookieConsent(settings))
    : '';

  return resolvePreviewMedia(buildHtml({
    page,
    versionId,
    settings,
    headerHtml,
    footerHtml,
    bodyHtml,
    blocksBody,
    blockCss,
    blockJs,
    allowScripts: opts.allowScripts === true,
    editorCanvasId: opts.editorCanvasId,
    editorCanvasInteractive: opts.annotate === true,
    extensionRuntime,
    editorExtensionRuntime,
    previewNavigationBridge,
    cookieConsentHtml,
    robotsBlocked,
    seoHead: (() => {
      if (!seoBase) return '';
      const pathname = applyTrailingSlash('/' + pagePathSegment(page), settings.trailing_slash ?? 'always');
      const canonical = page.canonical_url || new URL(pathname, seoBase).href;
      const schema = [breadcrumbJsonLd({ pathname, canonical, baseUrl: seoBase, title: page.title, siteName: settings.site_name, breadcrumbs }),
        page.schema_type ? buildPageSchema(page, settings, canonical) : buildContentPageSchema(publicContentPage(page, contentType), contentType, settings, canonical)];
      return `<link rel="canonical" href="${escapeAttr(canonical)}" />` + schema.filter(Boolean).map(value => `<script type="application/ld+json">${value!.replace(/</g, '\\u003c')}</script>`).join('');
    })(),
    banner: opts.showBanner ? {
      versionId,
      pageStatus: page.status,
      pageSlug: page.slug,
      liveUrl: opts.liveBase && (page.status === 'published' || page.status === 'unlisted') && isContentDeployed(opts.deployedVersion ?? null, page) ? joinUrl(opts.liveBase, pagePathSegment(page)) : null,
      editorUrl: `/app/sites/${siteId}/pages/${page.id}`,
    } : null,
  }), orgId, siteId, opts);
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
  const types = new Map((await vstore.contentTypes(orgId, siteId, versionId)).map(type => [type.id, type]));
  if (!types.has('page')) types.set('page', DEFAULT_CONTENT_TYPE);
  const pages = (await vstore.pages(orgId, siteId, versionId)).flatMap(page => {
    const type = types.get(page.content_type ?? 'page');
    const resolved = type ? resolveContentPage(page, type) : null;
    return resolved ? [resolved] : [];
  });
  const slugPath = slugParts.join('/').replace(/^\/+|\/+$/g, '');
  const norm = (s: string | undefined) => (s ?? '').replace(/^\/+|\/+$/g, '');
  const isHome = slugPath === '' || slugPath === 'home' || slugPath === 'index';
  const pageMatch = isHome
    ? pages.find((p) => {
        const s = norm(p.path !== undefined ? p.path : p.slug);
        return s === '' || s === 'home' || s === 'index';
      })
    : pages.find((p) => norm(p.path !== undefined ? p.path : p.slug) === slugPath);
  if (pageMatch) return renderPreview(orgId, siteId, pageMatch.id, versionId, opts);

  return null;
}

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

function buildPreviewNavigationBridgeScript(opts: PreviewOptions): string {
  if (!opts.extensionPreviewBridge || !opts.browseRoot) return '';
  const authQuery = Array.from(
    new URLSearchParams((opts.embedSuffix ?? '').replace(/^\?/, '')).entries(),
  );
  const config = JSON.stringify({
    root: opts.browseRoot.replace(/\/$/, ''),
    authQuery,
    bridge: opts.extensionPreviewBridge,
  }).replace(/</g, '\\u003c');
  return `(function(){"use strict";var config=${config};document.addEventListener("click",function(event){if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;var target=event.target;if(!(target instanceof Element))return;var anchor=target.closest("a[href]");if(!anchor||anchor.target&&anchor.target!=="_self"||anchor.hasAttribute("download"))return;var url;try{url=new URL(anchor.href,location.href);}catch(_){return;}if(url.origin!==location.origin||!(url.pathname===config.root||url.pathname.startsWith(config.root+"/")))return;var query=new URLSearchParams(url.search);config.authQuery.forEach(function(pair){var values=query.getAll(pair[0]),removed=false;query.delete(pair[0]);values.forEach(function(value){if(!removed&&value===pair[1])removed=true;else query.append(pair[0],value);});});var path=url.pathname.slice(config.root.length)||"/";var suffix=query.toString();event.preventDefault();parent.postMessage({channel:"typeroll.extension-preview",version:1,bridge_id:config.bridge.id,action:"site.navigate",path:path+(suffix?"?"+suffix:"")+url.hash},config.bridge.parentOrigin);},true);})();`;
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
  if (!settings.default_seo_suffix || page.append_seo_suffix === false) return base;
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
  extensionRuntime?: string;
  editorExtensionRuntime?: string;
  previewNavigationBridge?: string;
  cookieConsentHtml?: string;
  robotsBlocked: boolean;
  seoHead?: string;
  banner: BannerArgs | null;
}): string {
  const { page, settings, headerHtml, footerHtml, bodyHtml, blocksBody, blockCss, blockJs, allowScripts, editorCanvasId, editorCanvasInteractive, extensionRuntime, editorExtensionRuntime, previewNavigationBridge, cookieConsentHtml, robotsBlocked, banner } = args;
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
  const robots = pageRobots(page, settings, robotsBlocked);

  return `<!doctype html>
<html lang="${escapeAttr(page.language || settings.language || 'en')}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(composePageTitle(page, settings))}</title>
<meta name="description" content="${escapeAttr(page.seo_description || settings.default_meta_description || settings.tagline || '')}" />
<meta name="robots" content="${robots}" />
${args.seoHead ?? ''}
${settings.favicon ? `<link rel="icon" href="${escapeAttr(settings.favicon)}" />` : ''}
${settings.apple_touch_icon ? `<link rel="apple-touch-icon" sizes="180x180" href="${escapeAttr(settings.apple_touch_icon)}" />` : ''}
${settings.icon_192 ? `<link rel="icon" type="image/png" sizes="192x192" href="${escapeAttr(settings.icon_192)}" />` : ''}
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
  --font-heading:${fontFamilyCss(f.heading)};
  --font-body:${fontFamilyCss(f.body)};
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
html{height:100%}body{min-height:100%}
html{font-size:var(--font-size-base)}
body{font-family:var(--font-body),-apple-system,BlinkMacSystemFont,sans-serif;color:var(--color-text);background:var(--color-background);line-height:1.5;-webkit-font-smoothing:antialiased}
img,svg,video{display:block;max-width:100%;height:auto}
h1,h2,h3,h4,h5,h6{font-family:var(--font-heading),sans-serif;line-height:1.2}
a{color:var(--color-primary)}
${CONTENT_WELL_CSS}
/* Mirror site-template/global.css — descendant typography defaults at
   specificity 0 so user class rules win. */
:where(.page-content) > * + *{margin-top:var(--spacing-md)}
:where(.page-content) h1{font-size:var(--type-h1);margin-top:var(--spacing-lg)}
:where(.page-content) h2{font-size:var(--type-h2);margin-top:var(--spacing-lg)}
:where(.page-content) h3{font-size:var(--type-h3);margin-top:var(--spacing-md)}
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
</style>
${blockCss ? `<style data-blocks="1">${blockCss}</style>` : ''}
${settings.custom_css ? `<style data-site-css="1">${settings.custom_css}</style>` : ''}
${page.custom_css ? `<style data-page-css="1">${page.custom_css}</style>` : ''}
${cookieConsentHtml ? `<script data-cookie-consent-early="1">${buildConsentEarlyPaintRuntime()}</script>` : ''}
</head>
<body>
${banner ? renderBanner(banner) : ''}
${headerHtml ? (looksLikeSemanticTag(headerHtml, 'header') ? headerHtml : `<header class="site-header">${headerHtml}</header>`) : ''}
<main class="${blocksBody ? 'page-content page-content--blocks' : 'page-content'}">${bodyHtml}</main>
${footerHtml ? (looksLikeSemanticTag(footerHtml, 'footer') ? footerHtml : `<footer class="site-footer">${footerHtml}</footer>`) : ''}
${blockJs ? `<script data-blocks="1">(function(){var registry={};window.TyperollBlocks={register:function(id,init){registry[id]=init;},init:function(){Object.keys(registry).forEach(function(id){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(function(el){try{registry[id](el,JSON.parse(el.getAttribute('data-block-data')||'{}'));}catch(e){console.error('[block init]',id,e);}});});}};${blockJs};window.TyperollBlocks.init();})();</script>` : ''}
${extensionRuntime ? `<script data-extension-runtime="1">${extensionRuntime}</script>` : ''}
${editorExtensionRuntime ? `<script data-editor-extension-runtime="1">${editorExtensionRuntime}</script>` : ''}
${previewNavigationBridge ? `<script data-preview-navigation-bridge="1">${previewNavigationBridge}</script>` : ''}
${editorCanvasId ? `<script data-editor-canvas-bridge="1">${editorCanvasBridgeScript(editorCanvasId, editorCanvasInteractive === true)}</script>` : ''}
${cookieConsentHtml ?? ''}
</body>
</html>`;
}

function renderPreviewCookieConsent(settings: SiteSettings): string {
  const text = settings.cookie_consent?.text;
  const bodyHtml = text
    ? sanitizeBody(text, settings.iframe_allowed_hosts)
    : `<p>${DEFAULT_COOKIE_CONSENT_TEXT}</p>`;
  return renderCookieConsent(settings.cookie_consent, bodyHtml);
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
  const fams = Array.from(new Set([heading, body].filter(value => value && !isSystemFont(value))));
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

async function resolvePreviewMedia(html: string, orgId: string, siteId: string, opts: PreviewOptions) {
  if (opts.sharedMediaToken) return html;
  const { authorizePreviewMedia } = await import('./publishing/media-storage');
  return authorizePreviewMedia(html, orgId, siteId);
}

async function previewFormSource(orgId: string, siteId: string, blockRegistry: ReturnType<typeof buildCoreBlockRegistry>, settings: SiteSettings, assetBlocks: Block[]) {
    const { renderFormHtml } = await import('@typeroll/shared');
    const { formEmbedInfo, POW_BITS, isFormsSigningConfigured } = await import('./forms-signing');
    const { resolveAppFormEndpoint } = await import('./apps/form-endpoint');
    type F = import('@typeroll/shared').Form;
    let forms: F[] = [];
    try { forms = await getStore().listDocs<F>(paths.forms(orgId, siteId)); } catch { forms = []; }
    const byId = new Map(forms.map((f) => [f.id, f]));
    const endpoints = new Map<string, Awaited<ReturnType<typeof resolveAppFormEndpoint>> | Error>(await Promise.all(forms.map(async form => {
      try { return [form.id, await resolveAppFormEndpoint(form, { orgId, siteId, portalUrl: (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/$/, '') })] as const; }
      catch (error) { return [form.id, error instanceof Error ? error : new Error('Form app unavailable')] as const; }
    })));
    return (formId: string) => {
      const form = byId.get(formId);
      if (!form || (form.steps?.length ?? 0) === 0) return undefined;
      assetBlocks.push(...form.steps!.flatMap((step) => step.blocks ?? []));
      // Same resolver the deploy runner uses — an app-backed form must
      // preview against the endpoint it will actually ship with.
      const appEndpoint = endpoints.get(form.id);
      if (appEndpoint instanceof Error) throw appEndpoint;
      const embed = appEndpoint ?? formEmbedInfo(orgId, siteId, formId);
      return renderFormHtml(form, embed, {
        registry: blockRegistry,
        pow_bits: appEndpoint ? 0 : (isFormsSigningConfigured() ? POW_BITS : 0),
        lang: (settings as { language?: string }).language,
      });
    };

}
