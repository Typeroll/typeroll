import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse, apiError } from '../../../../lib/api-auth';
import { publishingJsonBody, connectionFailure } from '../../../../lib/publishing/http';
import { mediaMigrationStatus, requestMediaMigration } from '../../../../lib/publishing/media-migration';

async function handle(request: Request, retry: boolean) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.tokenSiteId !== null) return apiError('An organization API key is required to manage media migration.', 403);
  try {
    if (retry) { await publishingJsonBody(request); await requestMediaMigration(ctx.tokenOrgId); }
    return apiResponse(ctx, { migration: await mediaMigrationStatus(ctx.tokenOrgId) });
  } catch (error) { return connectionFailure(error); }
}
export const GET: APIRoute = ({ request }) => handle(request, false);
export const POST: APIRoute = ({ request }) => handle(request, true);
