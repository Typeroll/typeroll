import type { APIRoute } from 'astro';
import { requireApiKey, apiResponse, apiError } from '../../../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../../../lib/publishing/http';
import { domainGuideAction, readDomainGuide } from '../../../../../../lib/publishing/domain-guide';
async function handle(request: Request, siteId: string | undefined, write: boolean) {
  const guard = await requireApiKey(request, siteId); if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Domain management requires admin permission on the site.', 403);
  try { return apiResponse(ctx, write ? await domainGuideAction(ctx.orgId, ctx.siteId, await publishingJsonBody(request)) : await readDomainGuide(ctx.orgId, ctx.siteId)); }
  catch (error) { return connectionFailure(error); }
}
export const GET: APIRoute = ({ request, params }) => handle(request, params.siteId, false);
export const POST: APIRoute = ({ request, params }) => handle(request, params.siteId, true);
