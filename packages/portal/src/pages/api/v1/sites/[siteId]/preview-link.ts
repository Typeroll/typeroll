// POST /api/v1/sites/{siteId}/preview-link
//
// Mints a signed URL the agent can paste into its own browser/Playwright
// MCP. The URL navigates to the preview route with a query-token attached;
// the preview route accepts that token, renders from the DB (drafts
// included), and rewrites internal links so the agent can click through
// the site within the same token.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { vstore } from '../../../../../lib/version-store';
import { signPreviewTicket, isPreviewSigningConfigured } from '../../../../../lib/preview-signing';
import { contentPagePath, DEFAULT_CONTENT_TYPE } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!isPreviewSigningConfigured()) {
    return apiError('PREVIEW_HMAC_SECRET is not configured on this server', 503);
  }
  const body = (await request.json().catch(() => ({}))) as {
    page_id?: string;
    slug?: string;
    ttl_seconds?: number;
    /** Render editor working copies (unsaved autosaved edits) too. Signed
     *  into the token, so it can't be toggled on an existing link. */
    include_working_copy?: boolean;
  };

  let targetSlug = body.slug?.trim() ?? '';
  if (body.page_id) {
    const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, body.page_id);
    if (!page) return apiError(`Page ${body.page_id} not found`, 404);
    const type = await vstore.contentType(ctx.orgId, ctx.siteId, ctx.versionId, page.content_type ?? 'page')
      ?? ((page.content_type ?? 'page') === 'page' ? DEFAULT_CONTENT_TYPE : null);
    if (!type) return apiError('Content type not found', 404);
    const path = contentPagePath(page, type);
    if (path === null) return apiError('This content type has no public URL. Preview the page in the editor.', 400);
    targetSlug = path.replace(/^\/+/, '');
  }
  if (!targetSlug || targetSlug === 'home') targetSlug = '';

  const { token, expiresAt } = signPreviewTicket({
    orgId: ctx.orgId,
    siteId: ctx.siteId,
    versionId: ctx.versionId,
    ttlSeconds: body.ttl_seconds,
    includeWorkingCopies: body.include_working_copy === true,
  });

  // Astro's Node adapter on Cloud Run drops X-Forwarded-Host and reports
  // request.url with hostname='localhost' (same quirk that bit the CSRF
  // check). Prefer PORTAL_PUBLIC_URL (set by the deploy workflow to the
  // canonical portal URL) and fall back to request.url for self-hosted
  // / local-dev cases where the env isn't set.
  const portalUrl = process.env.PORTAL_PUBLIC_URL?.replace(/\/+$/, '');
  const origin = portalUrl ?? new URL(request.url).origin;
  const path = `/preview/${ctx.siteId}/${targetSlug}`.replace(/\/+$/, '/') || `/preview/${ctx.siteId}`;
  const url = `${origin}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
  return apiResponse(ctx, {
    url,
    expires_at: expiresAt,
    version_id: ctx.versionId,
    include_working_copy: body.include_working_copy === true,
  }, 200, body);
};
