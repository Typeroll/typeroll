// GET /api/v1/sites/{siteId}/pages/{pageId}/preview
//
// Returns the rendered HTML for one page (drafts + edits included), with a
// list of internal links extracted so the agent can decide what to navigate
// to next. Header-authed; for visual preview the agent uses POST
// /preview-link → opens the URL in a browser/screenshot tool.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import { renderPreview } from '../../../../../../../lib/render-preview';

function extractInternalLinks(html: string, siteOrigin: string): string[] {
  if (!html) return [];
  const links = new Set<string>();
  const re = /<a\s[^>]*href=(?:"([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? '').trim();
    if (!href) continue;
    if (href.startsWith('/') && !href.startsWith('//')) links.add(href);
    else if (siteOrigin && href.startsWith(siteOrigin)) links.add(href.slice(siteOrigin.length) || '/');
  }
  return Array.from(links);
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const pageId = params.pageId;
  if (!pageId) return apiError('Missing pageId');
  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return apiError('Not found', 404);

  // Use the in-portal preview renderer that the editor iframe already
  // hits. Same headers + footer injection, same sanitizer. `?annotate=true`
  // tags every block root with data-block-id/data-block-type so the agent can
  // map the rendered HTML back to the block to edit.
  const search = new URL(request.url).searchParams;
  const annotate = search.get('annotate') === 'true';
  // `?working_copy=true` overlays unsaved editor edits (working copies) so
  // an agent can see what's in progress in the editor before it's saved.
  const includeWorkingCopies = search.get('working_copy') === 'true';
  const html = await renderPreview(ctx.orgId, ctx.siteId, pageId, ctx.versionId, {
    annotate,
    includeWorkingCopies,
  });
  if (!html) return apiError('Page could not be rendered', 500);

  return apiResponse(ctx, {
    page_id: pageId,
    slug: page.slug,
    status: page.status,
    rendered_html: html,
    working_copy_included: includeWorkingCopies,
    internal_links: extractInternalLinks(html, ''),
  });
};
