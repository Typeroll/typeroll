// GET    /api/v1/sites/{siteId}/media/{mediaId}
// PATCH  /api/v1/sites/{siteId}/media/{mediaId}   alt_text, filename, public_path, demo (false only)
//        filename and public_path must end in an extension that matches the
//        media type (lib/media/file-types.ts).
// DELETE /api/v1/sites/{siteId}/media/{mediaId}
//
// DELETE removes the metadata doc but does NOT remove the underlying R2
// object today. Wiring up r2_key cleanup is a separate ticket because
// the in-app delete also doesn't do it.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import { publicMediaPath } from '../../../../../../lib/publishing/domain-config';
import { connectionFailure } from '../../../../../../lib/publishing/http';
import { assertMediaNameUpdate } from '../../../../../../lib/media/file-types';
import type { Media } from '@typeroll/shared';
import { importStatus, type ImportingMedia } from '../../../../../../lib/media/import-retry';

const WRITABLE: Array<keyof Media> = ['alt_text', 'filename', 'public_path'];

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  const doc = await getStore().getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!doc) return apiError('Not found', 404);
  // An import from a URL reports whether its copy is done, still being retried, or set aside.
  return apiResponse(ctx, { media: doc, import: importStatus(doc as ImportingMedia) });
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission === 'read') return apiError('Media changes require write permission.', 403);
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  const store = getStore();
  const existing = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!existing) return apiError('Not found', 404);
  const body = (await request.json().catch(() => null)) as Partial<Media> | null;
  if (!body) return apiError('Invalid JSON body');
  const update: Record<string, unknown> = {};
  for (const k of WRITABLE) if (body[k] !== undefined) update[k] = body[k];
  // Demo content from a package: the flag can only be cleared.
  if (body.demo !== undefined) {
    if (body.demo !== false) return apiError('demo can only be set to false (keep the file as the site\'s own)', 400, ctx, { code: 'media_demo_invalid' });
    update.demo = false;
  }
  if (Object.keys(update).length === 0) return apiError('No writable fields in body');
  if (update.public_path !== undefined) {
    try { update.public_path = update.public_path === null ? null : publicMediaPath(update.public_path); }
    catch (error) { return connectionFailure(error); }
  }
  try { assertMediaNameUpdate(existing, update); } catch (error) { return connectionFailure(error); }
  await store.updateDoc(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`, update);
  const fresh = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  return apiResponse(ctx, { media: fresh }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission === 'read') return apiError('Media changes require write permission.', 403);
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');
  await getStore().deleteDoc(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  return apiResponse(ctx, { ok: true });
};
