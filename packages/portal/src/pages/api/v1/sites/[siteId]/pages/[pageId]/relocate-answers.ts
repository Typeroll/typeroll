// POST /api/v1/sites/{siteId}/pages/{pageId}/relocate-answers
//
// A reviewed, one-time move of accepted answers to other paths of the same
// Page, keeping each answer's original source, actor, time, evidence and
// protection (lib/answer-relocation.ts). Send `dry_run: true` first; the
// answer is the receipt either way. Site administrators of the owning
// organization only: it carries other people's answers to new places.
import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { relocatePageAnswers } from '../../../../../../../lib/answer-relocation';
import { PageImportError } from '../../../../../../../lib/page-import';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Site administrator permission is required to relocate answers', 403, ctx);
  if (ctx.tokenOrgId !== ctx.orgId) return apiError('Only the owning organization can relocate answers', 403, ctx);
  if (!params.pageId) return apiError('Missing Page ID', 400);
  const input = await request.json().catch(() => null);
  try {
    const result = await relocatePageAnswers(ctx, params.pageId, input, `api-key:${ctx.keyPrefix}`);
    return apiResponse(ctx, result, 200, input);
  } catch (error) {
    if (error instanceof PageImportError) return apiResponse(ctx, { error: error.message, ...error.details as object }, error.status, input);
    throw error;
  }
};
