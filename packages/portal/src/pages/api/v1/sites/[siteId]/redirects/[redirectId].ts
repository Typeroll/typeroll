// DELETE /api/v1/sites/{siteId}/redirects/{redirectId}

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const redirectId = params.redirectId;
  if (!redirectId) return apiError('Missing redirectId');
  await getStore().deleteDoc(`${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${redirectId}`);
  return apiResponse(ctx, { ok: true });
};
