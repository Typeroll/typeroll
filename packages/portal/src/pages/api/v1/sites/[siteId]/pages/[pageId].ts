// /api/v1/sites/{siteId}/pages/{pageId}
//
// GET    — fetch one page. Returns the DRAFT VIEW: the saved doc with any
//          working-copy fields overlaid, plus has_unsaved_changes.
// PATCH  — shallow-merge update. Content fields land in the WORKING COPY
//          (the draft layer); `status`/`date_published` apply immediately.
//          Pass `save: true` to commit the working copy in the same call.
// PUT    — full replace of the writable content fields, into the working
//          copy (absent fields are cleared at commit). Same `save` flag.
// DELETE — remove the page (and its working copy).
//
// The buffer model: agents and the portal editor share one semantics —
// every content write is a draft until an explicit save (here `save: true`
// or POST /working-copy/page/{id}); deploys and default previews only see
// saved content.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { pageUrlFromDoc } from '../../../../../../lib/page-paths';
import { removeAutoRedirectsTargeting } from '../../../../../../lib/redirect-hygiene';
import { applyContentWrite } from '../../../../../../lib/content-write';
import {
  discardWorkingCopy,
  overlayWorkingCopy,
  readWorkingCopy,
  WorkingCopyError,
} from '../../../../../../lib/working-copy';
import { ensureBlockIds } from '@typeroll/shared';
import { checkAlternates } from '../../../../../../lib/page-alternates';
import type { Page } from '@typeroll/shared';

const WRITABLE: Array<keyof Page> = [
  'title', 'slug', 'path', 'html_content', 'blocks', 'status', 'content_mode', 'kind', 'author',
  'seo_title', 'seo_description', 'og_image', 'seo_image_alt', 'canonical_url', 'noindex',
  'alternates', 'lastmod_override', 'json_ld', 'schema_type', 'service',
  'template', 'date_published', 'language', 'image_sizes_default', 'custom_css',
  'publish_at', 'unpublish_at',
];

/** Content fields PUT clears when absent from the body ("PUT replaces"). */
const REPLACEABLE: Array<keyof Page> = WRITABLE.filter(
  (k) => k !== 'status' && k !== 'content_mode' && k !== 'date_published' && k !== 'slug'
    && k !== 'publish_at' && k !== 'unpublish_at',
);

function project(p: Page, hasUnsaved: boolean): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    path: p.path,
    url: pageUrlFromDoc(p),
    status: p.status,
    content_mode: p.content_mode,
    html_content: p.html_content,
    blocks: p.blocks,
    kind: p.kind,
    author: p.author,
    language: p.language,
    seo_title: p.seo_title,
    seo_description: p.seo_description,
    og_image: p.og_image,
    canonical_url: p.canonical_url,
    noindex: p.noindex,
    alternates: p.alternates,
    json_ld: p.json_ld,
    template: p.template,
    image_sizes_default: p.image_sizes_default,
    custom_css: p.custom_css,
    date_updated: p.date_updated,
    date_published: p.date_published,
    publish_at: p.publish_at ?? null,
    unpublish_at: p.unpublish_at ?? null,
    has_unsaved_changes: hasUnsaved,
  };
}

function pickWritable(body: Partial<Page>): Partial<Page> {
  const out: Partial<Page> = {};
  for (const k of WRITABLE) {
    if (body[k] !== undefined) (out as Record<string, unknown>)[k] = body[k];
  }
  // Whole-tree block writes must carry ids on every block — agents
  // hand-author trees without them, and an id-less block used to 500 the
  // renderer.
  if (Array.isArray(out.blocks)) {
    out.blocks = ensureBlockIds(out.blocks);
  }
  return out;
}

/** Draft view of a page: saved doc + working-copy overlay. */
async function draftView(
  ctx: { orgId: string; siteId: string; versionId: string },
  pageId: string,
): Promise<{ page: Page; hasUnsaved: boolean } | null> {
  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return null;
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  return { page: overlayWorkingCopy(page, wc), hasUnsaved: !!wc };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const view = await draftView(ctx, pageId);
  if (!view) return apiError('Not found', 404);
  return apiResponse(ctx, { page: project(view.page, view.hasUnsaved) });
};

async function handleWrite(
  ctx: { orgId: string; siteId: string; versionId: string; keyPrefix: string },
  pageId: string,
  fields: Record<string, unknown>,
  save: boolean,
): Promise<Record<string, unknown>> {
  const result = await applyContentWrite(
    ctx,
    { kind: 'page', id: pageId },
    fields,
    { save, updatedBy: `api-key:${ctx.keyPrefix}` },
  );
  const view = await draftView(ctx, pageId);
  return {
    page: view ? project(view.page, view.hasUnsaved) : null,
    saved: result.committed,
    staged_fields: result.staged,
    applied_immediately: result.applied_immediately,
    sanitization_warnings: result.sanitization_warnings,
    sanitization_details: result.sanitization_details,
    seo_warnings: result.seo_warnings,
    auto_redirects: result.auto_redirects,
    retired_redirects: result.retired_redirects,
  };
}

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as (Partial<Page> & { save?: boolean }) | null;
  if (!body) return apiError('Invalid JSON body');
  const alt = checkAlternates(body);
  if (!alt.ok) return apiError(alt.error);
  const update = pickWritable(body) as Record<string, unknown>;
  // null clears the cluster; the canonicalized array replaces whatever the
  // caller sent so stored tags are uniform.
  if (alt.present) update.alternates = alt.value;
  if (Object.keys(update).length === 0) return apiError('No writable fields in body');

  try {
    const payload = await handleWrite(ctx, pageId, update, body.save === true);
    return apiResponse(ctx, payload, 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as (Partial<Page> & { save?: boolean }) | null;
  if (!body) return apiError('Invalid JSON body');
  if (!String(body.title ?? '').trim()) return apiError('title required for PUT');
  const alt = checkAlternates(body);
  if (!alt.ok) return apiError(alt.error);
  if (alt.present) (body as Record<string, unknown>).alternates = alt.value;

  // "PUT replaces": every replaceable content field is set explicitly —
  // to the body's value or to null (cleared at commit). Slug falls back to
  // the current value so PUT can be "I don't care about the slug".
  const picked = pickWritable(body);
  const update: Record<string, unknown> = { ...picked };
  for (const k of REPLACEABLE) {
    if (!(k in update)) update[k] = null;
  }
  if (body.slug !== undefined) update.slug = body.slug;

  try {
    const payload = await handleWrite(ctx, pageId, update, body.save === true);
    return apiResponse(ctx, payload, 200, body);
  } catch (e) {
    if (e instanceof WorkingCopyError) return apiError(e.message, e.status);
    throw e;
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const existing = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!existing) return apiError('Not found', 404);
  await vstore.deletePage(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  await discardWorkingCopy(ctx, { kind: 'page', id: pageId });
  // Auto-generated redirects pointing at the deleted page's URL would 301
  // visitors into a 404 — drop them. Manual redirects are kept on purpose.
  const removed = await removeAutoRedirectsTargeting(
    ctx.orgId, ctx.siteId, ctx.versionId, pageUrlFromDoc(existing),
  );
  return apiResponse(ctx, {
    ok: true,
    removed_redirects: removed.map((r) => ({ from_path: r.from_path, to_path: r.to_path })),
  });
};
