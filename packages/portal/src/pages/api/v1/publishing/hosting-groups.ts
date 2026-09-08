import { updateHostingConnection } from '../../../../lib/publishing/hosting-connection';
import type { APIRoute } from 'astro';
import { requireAnyApiKey, apiResponse, apiError } from '../../../../lib/api-auth';
import { connectionFailure, publishingJsonBody } from '../../../../lib/publishing/http';
import { listHostingGroups, saveHostingGroup } from '../../../../lib/publishing/hosting-groups';

async function handle(request: Request, write: boolean) {
  const guard = await requireAnyApiKey(request);
  if (!guard.ok) return guard.response;
  if (guard.value.tokenSiteId !== null) return apiError('An organization API key is required to manage Hosting Groups.', 403);
  try {
    const org = guard.value.tokenOrgId;
    const input = write ? await publishingJsonBody(request) : null;
    const result = input ? input.action ? await updateHostingConnection(org, input) : await saveHostingGroup(org, input) : { groups: await listHostingGroups(org) };
    const response = apiResponse(guard.value, result);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) { return connectionFailure(error); }
}
export const GET: APIRoute = ({ request }) => handle(request, false);
export const POST: APIRoute = ({ request }) => handle(request, true);
export const PUT = POST;
