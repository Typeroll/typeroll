// GET /api/v1/sites/{siteId}/pages/{pageId}/revisions/{revId}/preview
//
// Renders one saved page revision as the whole preview document (header,
// body, footer, site CSS and block scripts), exactly as the portal's History
// panel shows it before a restore. Read-only. The snapshot's fields are laid
// over the page's current ones, and the current header, footer and settings
// give it context. `?annotate=true` tags block roots with data-block-id and
// data-block-type, as on GET /pages/{pageId}/preview.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../../../lib/api-auth';
import { renderPageRevisionPreview } from '../../../../../../../../../lib/revision-preview';
import { extractInternalLinks } from '../../../../../../../../../lib/preview-links';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const { pageId, revId } = params;
  if (!pageId || !revId) return apiError('Missing pageId or revId', 400, ctx);
  const annotate = new URL(request.url).searchParams.get('annotate') === 'true';
  const rendered = await renderPageRevisionPreview({
    orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, pageId, revId, annotate,
  });
  if (!rendered.ok) return apiError(rendered.error, rendered.status, ctx);
  return apiResponse(ctx, {
    page_id: pageId,
    revision_id: revId,
    slug: rendered.page.slug,
    title: rendered.page.title,
    rendered_html: rendered.html,
    internal_links: extractInternalLinks(rendered.html, ''),
  });
};
