// GET  /api/v1/sites/{siteId}/redirects
// POST /api/v1/sites/{siteId}/redirects

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { vstore } from '../../../../../../lib/version-store';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import { checkRedirectWrite, redirectDocId } from '../../../../../../lib/redirect-write';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const items = await vstore.redirects(ctx.orgId, ctx.siteId, ctx.versionId);
  return apiResponse(ctx, {
    redirects: items.map((r) => ({
      id: r.id,
      from_path: r.from_path,
      to_path: r.to_path,
      status_code: r.status_code,
      auto_generated: r.auto_generated,
    })),
  });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as {
    from_path?: string;
    to_path?: string;
    status_code?: number;
  } | null;
  if (!body) return apiError('Invalid JSON body');
  const from_path = (body.from_path ?? '').trim();
  const to_path = (body.to_path ?? '').trim();
  if (!from_path || !to_path) return apiError('from_path and to_path required');
  const status_code = (body.status_code === 302 ? 302 : 301) as 301 | 302;
  const check = await checkRedirectWrite({
    orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, from_path, to_path,
  });
  if (!check.ok) return apiError(check.error);
  const id = redirectDocId(from_path);
  await getStore().setDoc(`${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${id}`, {
    from_path,
    to_path,
    status_code,
    auto_generated: false,
  });
  return apiResponse(ctx, { redirect: { id, from_path, to_path, status_code } }, 201, body);
};
