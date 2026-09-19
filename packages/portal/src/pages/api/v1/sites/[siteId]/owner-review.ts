import type { APIRoute } from 'astro';
import { requireApiKey, apiError } from '../../../../../lib/api-auth';
import { handleOwnerReviewAdmin } from '../../../../../lib/owner-review-http';
const handle: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const requestedVersion = new URL(request.url).searchParams.get('version');
  if (requestedVersion && requestedVersion !== ctx.versionId) return apiError('Version not found', 404);
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Site administrator access is required', 403);
  return handleOwnerReviewAdmin(ctx, ctx.keyPrefix, request);
};
export const GET = handle;
export const POST = handle;
