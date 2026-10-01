// GET /api/v1/sites/{siteId}/partials       — list global blocks
// POST /api/v1/sites/{siteId}/partials      — create a free block (header
//                                              and footer are special — use
//                                              PUT /partials/{id} for those)

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { sanitizeBody } from '../../../../../../lib/sanitize';
import { ensureBlockIds, type Partial as PartialDoc } from '@typeroll/shared';
import { blockTreeInputError } from '../../../../../../lib/block-tree-input';

function project(p: PartialDoc, summary: boolean): Record<string, unknown> {
  const base = {
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    content_mode: p.content_mode,
    date_updated: p.date_updated,
  };
  // Summary mode drops html_content + content size hint so the agent's
  // context isn't blown by listing 30 partials each carrying 2 KB of HTML.
  // Use read_partial / GET /partials/{id} to fetch the full content.
  if (p.content_mode === 'blocks') return summary ? { ...base, block_count: (p.blocks ?? []).length } : { ...base, blocks: p.blocks ?? [] };
  return summary
    ? { ...base, html_content_bytes: (p.html_content ?? '').length }
    : { ...base, html_content: p.html_content };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const url = new URL(request.url);
  const summary = url.searchParams.get('summary') === 'true';
  const list = await vstore.partials(ctx.orgId, ctx.siteId, ctx.versionId);
  return apiResponse(ctx, { partials: list.map((p) => project(p, summary)) });
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as Partial<PartialDoc> | null;
  if (!body) return apiError('Invalid JSON body');
  const id = String(body.id ?? '').trim();
  if (!id || !SLUG_RE.test(id)) return apiError('id must be kebab-case [a-z0-9-]');
  if (id === 'header' || id === 'footer') {
    return apiError('Use PUT /partials/header or /partials/footer for the layout blocks');
  }
  const existing = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, id);
  if (existing) return apiError(`Block ${id} already exists; use PUT/PATCH`, 409);

  // Block content makes a global block that block-mode pages reference with
  // core/global_block; HTML content is for <x-include> in HTML pages.
  if (body.blocks !== undefined) {
    const error = blockTreeInputError(body.blocks);
    if (error || !Array.isArray(body.blocks) || !body.blocks.length) return apiError(error ?? 'blocks must be a non-empty block tree', 400);
    if (body.html_content !== undefined) return apiError('Send either blocks or html_content, not both', 400);
  }
  if (body.status !== undefined && !['draft', 'published'].includes(String(body.status))) return apiError('status must be draft or published', 400);
  const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
  const doc: Partial<PartialDoc> = {
    name: body.name ? String(body.name) : id,
    kind: 'free',
    status: (body.status as PartialDoc['status']) ?? 'published',
    date_updated: new Date().toISOString(),
    ...(body.blocks !== undefined
      ? { content_mode: 'blocks' as const, blocks: ensureBlockIds(body.blocks) }
      : { content_mode: 'html' as const, html_content: sanitizeBody(String(body.html_content ?? ''), settings?.iframe_allowed_hosts) }),
  };
  await vstore.writePartial(ctx.orgId, ctx.siteId, ctx.versionId, id, doc);
  const fresh = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, id);
  // POST returns the full body — caller just created it and is unlikely to
  // round-trip a separate read_partial to see what landed.
  return apiResponse(ctx, { partial: fresh ? project(fresh, false) : null }, 201, body);
};
