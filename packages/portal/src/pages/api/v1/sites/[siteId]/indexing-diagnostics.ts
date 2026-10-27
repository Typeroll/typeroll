import { previousHostSummary } from '../../../../../lib/publishing/previous-hosts';
import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { vstore } from '../../../../../lib/version-store';
import { diagnoseSiteIndexing } from '../../../../../lib/indexing-diagnostics';
import { getSiteDomains } from '../../../../../lib/publishing/domain-config';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const settings = await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId);
  if (!settings) return apiError('Site settings not found', 404);

  // Customer publishing intentionally blocks robots until a future website host
  // is declared. The generated Site.domain may still contain its temporary host.
  const domains = ctx.site.publishing_mode === 'customer_git' ? await getSiteDomains(ctx.orgId, ctx.siteId) : null;
  const report = await diagnoseSiteIndexing(ctx.site, settings, {
    robotsBlocked: domains !== null && !domains.desired.website_host,
    previousHosts: domains ? previousHostSummary(domains) : [], publicationId: domains?.published?.publication_id,
  });
  return apiResponse(ctx, report);
};
