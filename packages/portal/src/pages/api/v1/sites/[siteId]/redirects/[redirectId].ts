// PATCH  /api/v1/sites/{siteId}/redirects/{redirectId}
// DELETE /api/v1/sites/{siteId}/redirects/{redirectId}

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Redirect } from '@typeroll/shared';
import { checkRedirectWrite } from '../../../../../../lib/redirect-write';

/** Change a rule's target or status in place: the id and source path stay the same. */
export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const redirectId = params.redirectId;
  if (!redirectId) return apiError('Missing redirectId');
  const body = (await request.json().catch(() => null)) as {
    from_path?: unknown;
    to_path?: unknown;
    status_code?: unknown;
  } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Invalid JSON body');
  const path = `${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${redirectId}`;
  const current = await getStore().getDoc<Redirect>(path);
  if (!current) return apiError('Redirect not found', 404, ctx);
  if (body.from_path !== undefined && body.from_path !== current.from_path)
    return apiError('from_path cannot change. Create a rule for the new source path and delete this one.');
  if (body.to_path !== undefined && typeof body.to_path !== 'string') return apiError('to_path must be a string');
  if (body.status_code !== undefined && body.status_code !== 301 && body.status_code !== 302)
    return apiError('status_code must be 301 or 302');
  const to_path = body.to_path === undefined ? current.to_path : (body.to_path as string).trim();
  const status_code = (body.status_code ?? current.status_code) as 301 | 302;
  if (!to_path) return apiError('to_path required');
  const check = await checkRedirectWrite({
    orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, from_path: current.from_path, to_path,
  });
  if (!check.ok) return apiError(check.error);
  const { id: _id, ...stored } = current;
  // An edited rule is authored; automatic rule maintenance must not replace it.
  await getStore().setDoc(path, { ...stored, to_path, status_code, auto_generated: false });
  return apiResponse(ctx, {
    redirect: { id: redirectId, from_path: current.from_path, to_path, status_code },
    warnings: check.warnings ?? [],
  }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const redirectId = params.redirectId;
  if (!redirectId) return apiError('Missing redirectId');
  await getStore().deleteDoc(`${paths.redirects(ctx.orgId, ctx.siteId, ctx.versionId)}/${redirectId}`);
  return apiResponse(ctx, { ok: true });
};
