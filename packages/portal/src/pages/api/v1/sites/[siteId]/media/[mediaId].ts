// GET    /api/v1/sites/{siteId}/media/{mediaId}
// PATCH  /api/v1/sites/{siteId}/media/{mediaId}   alt_text, filename
// DELETE /api/v1/sites/{siteId}/media/{mediaId}
//
// DELETE removes the metadata doc but does NOT remove the underlying R2
// object today. Wiring up r2_key cleanup is a separate ticket because
// the in-app delete also doesn't do it.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Media } from '@typeroll/shared';

const WRITABLE: Array<keyof Media> = ['alt_text', 'filename'];

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  const doc = await getStore().getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!doc) return apiError('Not found', 404);
  return apiResponse(ctx, { media: doc });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  const store = getStore();
  const existing = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as Partial<Media> | null;
  if (!body) return apiError('Invalid JSON body');
  const update: Record<string, unknown> = {};
  for (const k of WRITABLE) if (body[k] !== undefined) update[k] = body[k];
  if (Object.keys(update).length === 0) return apiError('No writable fields in body');
  await store.setDoc(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`, { ...existing, ...update });
  const fresh = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  return apiResponse(ctx, { media: fresh }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  await getStore().deleteDoc(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  return apiResponse(ctx, { ok: true });
};
