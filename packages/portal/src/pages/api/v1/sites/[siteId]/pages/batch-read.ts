// POST /api/v1/sites/{siteId}/pages/batch-read
//
// Body: { page_ids: string[] }   — up to BATCH_MAX
// Returns: { pages: Array<{ page_id, found, page? }> }
//
// Why a POST instead of GET with comma-separated ids: agents routinely
// hit hundreds of ids at once and URL-length limits kick in fast. POST
// keeps the body shape consistent with batch-write, which has to be POST
// anyway. We're not creating a resource — the audit log treats this as
// a read (POST with no state change → not audited).

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import type { Page } from '@typeroll/shared';

const BATCH_MAX = 200;

function project(p: Page): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    content_mode: p.content_mode,
    html_content: p.html_content,
    kind: p.kind,
    seo_title: p.seo_title,
    seo_description: p.seo_description,
    noindex: p.noindex,
    json_ld: p.json_ld,
    date_updated: p.date_updated,
  };
}

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as { page_ids?: unknown } | null;
  if (!body || !Array.isArray(body.page_ids)) {
    return apiError('Body must be { page_ids: string[] }');
  }
  const ids = (body.page_ids as unknown[]).filter((x): x is string => typeof x === 'string');
  if (ids.length === 0) return apiResponse(ctx, { pages: [] });
  if (ids.length > BATCH_MAX) return apiError(`Too many ids (max ${BATCH_MAX})`);

  // Parallel reads against the chain — chain reads are cheap, and the
  // datastore handles the merge tombstones internally.
  const results = await Promise.all(
    ids.map(async (id) => {
      const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, id);
      return page ? { page_id: id, found: true, page: project(page) } : { page_id: id, found: false };
    }),
  );
  return apiResponse(ctx, { pages: results });
};
