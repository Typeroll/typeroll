// GET /api/v1/sites/{siteId}/partials       — list global blocks
// POST /api/v1/sites/{siteId}/partials      — create a free block (header
//                                              and footer are special — use
//                                              PUT /partials/{id} for those)

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { sanitizeBody } from '../../../../../../lib/sanitize';
import type { Partial as PartialDoc } from '@typeroll/shared';

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

  const html = sanitizeBody(String(body.html_content ?? ''));
  const doc: Partial<PartialDoc> = {
    name: body.name ? String(body.name) : id,
    kind: 'free',
    content_mode: 'html',
    status: (body.status as PartialDoc['status']) ?? 'published',
    html_content: html,
    date_updated: new Date().toISOString(),
  };
  await vstore.writePartial(ctx.orgId, ctx.siteId, ctx.versionId, id, doc);
  const fresh = await vstore.partial(ctx.orgId, ctx.siteId, ctx.versionId, id);
  // POST returns the full body — caller just created it and is unlikely to
  // round-trip a separate read_partial to see what landed.
  return apiResponse(ctx, { partial: fresh ? project(fresh, false) : null }, 201, body);
};
