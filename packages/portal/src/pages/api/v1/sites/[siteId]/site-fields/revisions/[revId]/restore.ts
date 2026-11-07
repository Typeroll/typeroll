// POST /api/v1/sites/{siteId}/site-fields/revisions/{revId}/restore
//
// Saves a revision's definitions and values as the site fields (site admin,
// since the definitions change too). The document as it was is kept as a
// revision first, so the restore is undoable.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey, withApiIdentity } from '../../../../../../../../lib/api-auth';
import { json } from '../../../../../../../../lib/access';
import { getRevision } from '../../../../../../../../lib/revisions';
import { restoreSiteFieldsRevision, siteFieldsFailureBody, siteFieldsResponse } from '../../../../../../../../lib/site-fields-write';
import { pathParam } from '../../../../../../../../lib/path-param';
import type { SiteFields } from '@typeroll/shared';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin') return apiError('Restoring site fields needs admin permission on the site', 403, ctx);
  const revId = pathParam(params.revId);
  if (!revId) return apiError('Missing revId', 400, ctx);
  const rev = await getRevision({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId, kind: 'site_fields', resourceIds: ['default'], revId });
  if (!rev) return apiError('Revision not found', 404, ctx);
  try {
    const siteFields = await restoreSiteFieldsRevision(ctx, rev.doc as Partial<SiteFields>, revId, { permission: ctx.permission, updatedBy: `api-key:${ctx.keyPrefix}` });
    return apiResponse(ctx, { restored_revision: revId, ...siteFieldsResponse(siteFields, ctx.permission) }, 200, {});
  } catch (error) {
    const refused = siteFieldsFailureBody(error);
    if (!refused) throw error;
    return withApiIdentity(ctx, json(refused.body, refused.status));
  }
};
