import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { pageAuthorityFields } from '@typeroll/shared';
import { pageContentType } from '../../../../../../../lib/page-fields';
import { vstore } from '../../../../../../../lib/version-store';
import { analyzeCompleteness } from '../../../../../../../lib/page-completeness';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId); if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const type = await pageContentType(ctx, { content_type: params.name });
  if (!type) return apiError('Content type not found', 404);
  const query = new URL(request.url).searchParams;
  const limit = Number(query.get('limit') ?? 50), days = Number(query.get('stale_after_days') ?? 180);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isFinite(days) || days < 0) return apiError('Use a limit from 1 to 200 and non-negative stale_after_days', 400);
  const pages = (await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId)).filter(page => (page.content_type ?? 'page') === type.id);
  return apiResponse(ctx, analyzeCompleteness({ ...type, fields: pageAuthorityFields(type) }, pages, { limit, stale_after_days: days, agent_writable_only: query.get('agent_writable_only') !== 'false' }));
};
