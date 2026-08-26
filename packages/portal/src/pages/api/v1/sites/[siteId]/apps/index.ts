import type { APIRoute } from 'astro';
import { paths } from '@typeroll/shared';
import type { SiteApps } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { maskAppState } from '../../../../../../lib/apps/config';
import { listAppDefs } from '../../../../../../lib/apps/registry';
import { getStore } from '../../../../../../lib/datastore';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Insufficient permission (admin required)', 403);

  const doc = await getStore().getDoc<SiteApps>(paths.apps(ctx.orgId, ctx.siteId));
  return apiResponse(ctx, {
    apps: listAppDefs().map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      affects_build: Boolean(def.affects_build),
      fields: def.fields,
      state: maskAppState(def.id, doc?.apps?.[def.id]),
    })),
  });
};
