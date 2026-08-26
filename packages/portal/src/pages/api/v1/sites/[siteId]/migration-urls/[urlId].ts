// PATCH  /api/v1/sites/{siteId}/migration-urls/{urlId} — mark excluded / annotate
// DELETE /api/v1/sites/{siteId}/migration-urls/{urlId} — drop from the inventory
//
// `excluded` is the sign-off mechanism: a URL the customer accepts will 404
// after cutover. It's the difference between "we haven't looked at this yet"
// and "we decided", which is the whole point of the coverage report.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { MigrationUrl } from '@typeroll/shared';

const WRITABLE = ['excluded', 'notes', 'gsc_clicks', 'gsc_impressions'] as const;

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const urlId = params.urlId;
  if (!urlId) return apiError('Missing urlId');

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiError('Invalid JSON body');

  const update: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === 'excluded' && typeof value !== 'boolean') return apiError('excluded must be a boolean');
    if (key === 'notes' && typeof value !== 'string') return apiError('notes must be a string');
    if ((key === 'gsc_clicks' || key === 'gsc_impressions') && typeof value !== 'number') {
      return apiError(`${key} must be a number`);
    }
    update[key] = value;
  }
  if (!Object.keys(update).length) {
    return apiError(`No writable fields. Writable: ${WRITABLE.join(', ')}`);
  }

  const docPath = paths.migrationUrl(ctx.orgId, ctx.siteId, urlId);
  const existing = await getStore().getDoc<MigrationUrl>(docPath);
  if (!existing) return apiError('Inventory URL not found', 404);
  await getStore().updateDoc(docPath, update);

  return apiResponse(ctx, { url: { ...existing, ...update, id: urlId } }, 200, body);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const urlId = params.urlId;
  if (!urlId) return apiError('Missing urlId');

  const docPath = paths.migrationUrl(ctx.orgId, ctx.siteId, urlId);
  const existing = await getStore().getDoc<MigrationUrl>(docPath);
  if (!existing) return apiError('Inventory URL not found', 404);
  await getStore().deleteDoc(docPath);

  return apiResponse(ctx, { ok: true, deleted: urlId }, 200, { urlId });
};
