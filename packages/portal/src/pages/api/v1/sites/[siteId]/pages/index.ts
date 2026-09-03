// /api/v1/sites/{siteId}/pages
//
// GET — list pages. Supports ?status= (draft|review|unlisted|published|all)
// and ?limit= (default 50, max 200) and ?cursor=<opaque> for pagination.
// POST — create a new page.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { getStore } from '../../../../../../lib/datastore';
import { makeSafePageId, pageUrlFromDoc, validatePathField } from '../../../../../../lib/page-paths';
import { checkAlternates } from '../../../../../../lib/page-alternates';
import { isLivePageStatus, retireRedirectsShadowingUrl } from '../../../../../../lib/redirect-hygiene';
import { sanitizeBody } from '../../../../../../lib/sanitize';
import { buildMediaLookup, transformBodyForSeo } from '../../../../../../lib/seo-transform';
import { paths, slugify, ensureBlockIds } from '@typeroll/shared';
import type { Block, Media, Page } from '@typeroll/shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Cursor {
  after_id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(s: string | null): Cursor | null {
  if (!s) return null;
  try {
    const decoded = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof decoded?.after_id !== 'string') return null;
    return { after_id: decoded.after_id };
  } catch {
    return null;
  }
}

function projectPage(p: Page, full = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: p.id,
    title: p.title,
    slug: p.slug,
    path: p.path,
    url: pageUrlFromDoc(p),
    status: p.status,
    content_mode: p.content_mode,
    language: p.language,
    kind: p.kind,
    author: p.author,
    seo_title: p.seo_title,
    append_seo_suffix: p.append_seo_suffix,
    seo_description: p.seo_description,
    og_image: p.og_image,
    noindex: p.noindex,
    template: p.template,
    image_sizes_default: p.image_sizes_default,
    date_updated: p.date_updated,
    date_published: p.date_published,
  };
  if (full) {
    // Body fields included when explicitly requested (or on create/update
    // response) so the caller can verify what was stored without a follow-up.
    base.html_content = p.html_content;
    base.blocks = p.blocks;
  }
  return base;
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const status = (url.searchParams.get('status') ?? 'all').trim();
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  // ?full=true includes html_content + blocks in each page object. Default
  // is summary-only (id, title, slug, status, SEO) to avoid megabyte payloads
  // on sites with many pages. Use batch_read_pages or read_page for body content.
  const fullBody = url.searchParams.get('full') === 'true';

  let pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
  // Stable order so cursors don't shift between calls. id is unique and
  // immutable per page so it's the safe sort key.
  pages.sort((a, b) => a.id.localeCompare(b.id));
  if (status !== 'all') {
    pages = pages.filter((p) => p.status === status);
  }
  if (cursor) {
    const idx = pages.findIndex((p) => p.id === cursor.after_id);
    pages = idx >= 0 ? pages.slice(idx + 1) : pages;
  }
  const slice = pages.slice(0, limit);
  const nextCursor = pages.length > limit ? encodeCursor({ after_id: slice[slice.length - 1]!.id }) : null;

  return apiResponse(ctx, {
    pages: slice.map((p) => projectPage(p, fullBody)),
    next_cursor: nextCursor,
    total: undefined, // not computed — pagination is forward-only by design
  });
};

const CREATE_FIELDS = [
  'title', 'slug', 'path', 'html_content', 'blocks', 'status', 'content_mode', 'kind', 'author',
  'language', 'seo_title', 'seo_description', 'og_image', 'seo_image_alt', 'canonical_url',
  'append_seo_suffix',
  'noindex', 'alternates', 'lastmod_override', 'json_ld', 'schema_type', 'service', 'template',
  'image_sizes_default', 'custom_css',
] as const;


export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Partial<Page> | null;
  if (!body) return apiError('Invalid JSON body');
  const title = String(body.title ?? '').trim();
  if (!title) return apiError('title required');

  const existing = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);

  // Slug normalization and validation:
  // - Strip leading/trailing slashes so "/about" → "about" (graceful)
  // - Reject internal slashes — the data model and renderer actually support
  //   them (see docs/page-slug-audit.md), but the recommended primitive for
  //   nested URLs is a collection with `route_template`. The v1 API enforces
  //   the recommended path so AI agents don't accidentally proliferate flat
  //   pages where a collection would be the right shape.
  // - Empty string slug (or slug="/") = homepage, stored under id "home"
  // - Omitted slug = derive from title
  // Path-first routing (C6): `path` is the new authoritative URL field.
  // `slug` remains the single-segment leaf identifier. When both are set
  // the caller's path wins for routing; slug stays the local id. When only
  // slug is set, path is derived as "/" + slug — back-compat with every
  // existing caller. Nested URLs require an explicit `path`.
  const slugExplicit = body.slug !== undefined;
  let rawSlug = slugExplicit ? String(body.slug).replace(/^\/+/, '').replace(/\/+$/, '') : '';
  if (rawSlug.includes('/')) {
    return apiError(
      `Invalid slug "${body.slug}": page slugs must be a single path segment without slashes. ` +
      `Use "about" not "/about". For the homepage pass slug="" (empty string). ` +
      `For nested URLs, set the \`path\` field explicitly (e.g. "/erbjudanden/sommar") — ` +
      `\`slug\` stays the single-segment leaf identifier.`,
      400,
    );
  }
  const pathCheck = validatePathField((body as Record<string, unknown>).path);
  if (!pathCheck.ok) return apiError(`Invalid path: ${pathCheck.error}`, 400);
  const alt = checkAlternates(body);
  if (!alt.ok) return apiError(alt.error);
  if (alt.present) (body as Record<string, unknown>).alternates = alt.value;
  const explicitPath = pathCheck.path;  // '' when not provided

  // The intended URL is either explicit-path or derived from slug.
  const isHome = explicitPath === '/' || (slugExplicit && rawSlug === '' && explicitPath === '');
  let slug: string;
  let pageId: string;
  let i = 2;
  if (isHome) {
    slug = '';
    pageId = 'home';
    if (existing.some((p) => p.id === 'home')) {
      return apiError('A homepage already exists (page_id "home"). Use update_page to edit it.', 409);
    }
  } else {
    const base = rawSlug || slugify(title) || 'page';
    slug = base;
    // Derive pageId from the path when explicit, otherwise from slug.
    // Two pages CAN share a slug now (`sommar` under `/erbjudanden/` and
    // `/event/`), so id uniqueness is keyed on the full URL.
    let resolvedPath = explicitPath || `/${slug}`;
    pageId = makeSafePageId(resolvedPath);
    const urlTaken = (urlPath: string) => existing.some((p) => pageUrlFromDoc(p) === urlPath);
    const idTaken = (id: string) => existing.some((p) => p.id === id);
    while (urlTaken(resolvedPath) || idTaken(pageId)) {
      slug = `${base}-${i}`;
      resolvedPath = explicitPath
        // When path is explicit, suffix the LAST segment to keep the
        // prefix stable: /erbjudanden/sommar → /erbjudanden/sommar-2
        ? explicitPath.replace(/[^/]+$/, slug)
        : `/${slug}`;
      pageId = makeSafePageId(resolvedPath);
      i++;
    }
    // If the caller supplied an explicit path, persist it on the doc so
    // the renderer respects it. Otherwise leave path unset and let the
    // renderer fall back to "/" + slug (no behavioural change for
    // existing single-segment pages).
    if (explicitPath) (body as Record<string, unknown>).path = resolvedPath;
    else delete (body as Record<string, unknown>).path;
  }
  const status = (body.status as Page['status']) ?? 'draft';
  // Block-mode is the platform default for new pages — same shape the
  // portal UI's "New page" button creates, same shape the block editor
  // surfaces in. Callers who want raw-HTML mode pass
  // content_mode="html" explicitly. Passing html_content WITHOUT setting
  // content_mode also opts into HTML — the body field is the strong
  // signal of intent.
  const contentMode: 'blocks' | 'html' =
    body.content_mode === 'html' || (body.content_mode === undefined && typeof body.html_content === 'string')
      ? 'html'
      : 'blocks';
  const doc: Record<string, unknown> = {
    title,
    slug,
    content_mode: contentMode,
    status,
    date_updated: new Date().toISOString(),
    api_generated: true,
  };
  for (const k of CREATE_FIELDS) {
    if (body[k] !== undefined && k !== 'title' && k !== 'slug' && k !== 'status' && k !== 'content_mode') {
      doc[k] = body[k];
    }
  }
  // Sanitize + SEO-transform any incoming HTML body BEFORE storing — same
  // pipeline as PATCH/PUT. Without this, `create_page` from an AI/MCP
  // call ships raw <img> tags with no srcset/width/height + skips the
  // sanitizer. Match the existing v1 conventions: sanitize first, then
  // run the SEO transform, then persist.
  if (contentMode === 'html' && typeof doc.html_content === 'string' && doc.html_content) {
    // Pin into a local — the await below would otherwise re-widen
    // doc.html_content from string back to unknown (Record<string,
    // unknown> bracket access doesn't keep narrowed types across
    // suspension points).
    const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
    let html: string = sanitizeBody(doc.html_content, settings?.iframe_allowed_hosts);
    const media = await getStore().listDocs<Media>(paths.media(ctx.orgId, ctx.siteId));
    // Responsive-image `sizes` default: new page's own value overrides the
    // site-wide setting; a per-<img> `sizes` still wins inside the transform.
    const defaultSizes =
      (doc.image_sizes_default as string | undefined) ||
      settings?.image_sizes_default ||
      undefined;
    html = transformBodyForSeo(
      html,
      buildMediaLookup(media),
      { cfImageOrigin: process.env.CF_IMAGE_ORIGIN || undefined, defaultSizes },
    );
    doc.html_content = html;
  }

  // Seed body content when the caller didn't provide one. Lets agents
  // call `create_page` with just a title and get a non-empty page back
  // they can immediately render or continue editing.
  if (contentMode === 'html' && !body.html_content) {
    doc.html_content = '';
  } else if (contentMode === 'blocks' && !body.blocks) {
    doc.blocks = [
      { id: `blk_${Math.random().toString(36).slice(2, 14)}`, type: 'core/heading',
        data: { text: title, level: 'h1', align: 'left', eyebrow: '' } },
      { id: `blk_${Math.random().toString(36).slice(2, 14)}`, type: 'core/prose',
        data: { html: '<p>Start writing…</p>', max_width: 'normal' } },
    ];
  }
  // Hand-authored trees routinely arrive without block ids — normalise so
  // the renderer + per-block tools can address every block. (Regression:
  // a single id-less block 500'd the preview renderer.)
  if (Array.isArray(doc.blocks)) {
    doc.blocks = ensureBlockIds(doc.blocks as Block[]);
  }
  await getStore().setDoc(paths.page(ctx.orgId, ctx.siteId, pageId, ctx.versionId), doc);

  const created = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  // A live page created on a URL retires any redirect FROM that URL — the
  // redirect would otherwise shadow the page in `_redirects` on CF Pages
  // (this is how a stale "/" auto-redirect once hid a brand-new home page).
  // Draft creates leave redirects alone; retirement happens at publish.
  let retired: Array<{ from_path: string; to_path: string }> = [];
  if (created && isLivePageStatus(created.status)) {
    retired = (await retireRedirectsShadowingUrl(ctx.orgId, ctx.siteId, ctx.versionId, pageUrlFromDoc(created)))
      .map((r) => ({ from_path: r.from_path, to_path: r.to_path }));
  }
  // Always include body on create response so the caller can verify what was stored.
  return apiResponse(ctx, {
    page: created ? projectPage(created, true) : { id: pageId, ...doc },
    retired_redirects: retired,
  }, 201, body);
};
