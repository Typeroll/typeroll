// /api/v1/sites/{siteId}/pages
//
// GET — list pages. Supports ?status= (draft|review|unlisted|published|all)
// and ?limit= (default 50, max 200) and ?cursor=<opaque> for pagination.
// POST — create a new page.

import type { APIRoute } from 'astro';
import { pageSort, comparePageValues, pageContentValues, DEFAULT_CONTENT_TYPE, type Page } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { createPage } from '../../../../../../lib/page-create';
import { pageAddress } from '../../../../../../lib/page-fields';
import { WorkingCopyError } from '../../../../../../lib/working-copy';

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
    content_type: p.content_type ?? 'page',
    fields: p.fields ?? {},
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
    nofollow: p.nofollow,
    template: p.template,
    sort_order: p.sort_order,
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
  const contentType = url.searchParams.get('content_type');
  if (contentType) pages = pages.filter(page => (page.content_type ?? 'page') === contentType);
  // Stable order so cursors don't shift between calls. id is unique and
  // immutable per page so it's the safe sort key.
  const sortBy = url.searchParams.get('sort_by') || undefined;
  const direction = url.searchParams.get('sort_order');
  if (direction && !['asc', 'desc'].includes(direction)) return apiError('sort_order must be asc or desc', 400);
  const selectedType = url.searchParams.get('content_type');
  if (sortBy || selectedType) {
    const type = selectedType ? await vstore.contentType(ctx.orgId, ctx.siteId, ctx.versionId, selectedType) ?? (selectedType === 'page' ? DEFAULT_CONTENT_TYPE : undefined) : undefined;
    const sort = pageSort(type, { sort_by: sortBy, sort_order: (direction || undefined) as 'asc' | 'desc' | undefined });
    pages.sort((a, b) => comparePageValues(pageContentValues(a), pageContentValues(b), sort));
  } else pages.sort((a, b) => a.id.localeCompare(b.id));
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
    pages: await Promise.all(slice.map(async p => ({ ...projectPage(p, fullBody), url: await pageAddress(ctx, p) }))),
    next_cursor: nextCursor,
    total: undefined, // not computed — pagination is forward-only by design
  });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body', 400);
  try {
    const result = await createPage(ctx, body, 'agent', `api-key:${ctx.keyPrefix}`);
    return apiResponse(ctx, { ...result, page: { ...projectPage(result.page, true), url: await pageAddress(ctx, result.page) } }, 201, body);
  } catch (error) {
    if (error instanceof WorkingCopyError) return apiError(error.message, error.status);
    throw error;
  }
};
