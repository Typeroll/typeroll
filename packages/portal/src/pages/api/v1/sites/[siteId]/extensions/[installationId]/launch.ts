// POST /api/v1/sites/{siteId}/extensions/{installationId}/launch
//   body: { page_id: string }
//
// Issues the same single-use launch grant the portal issues when someone opens
// an Extension admin page. Returns the code with everything needed to open the
// page: POST `code`, `issuer`, `installation_id` and `page_id` as form fields to
// `launch_url` (for example from a browser automation tool) before
// `expires_at`. The provider exchanges the code for a delegated token whose
// subject is `api-key:{prefix}`. The page's `minimum_permission` applies as in
// the portal. For approved native admin pages, prefer
// POST .../admin-request, which calls the app's admin API directly.

import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { ExtensionAuthError, extensionIssuer, issueExtensionLaunchGrant } from '../../../../../../../lib/extensions/auth';
import { resolveExtensionVersion } from '../../../../../../../lib/extensions/resolution';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  // Installation credentials cannot act as a user of their own admin pages.
  if (ctx.extensionIdentity) return apiError('Installation credentials cannot launch admin pages', 403, ctx);
  if (!params.installationId) return apiError('Missing installationId', 400, ctx);
  const body = await request.json().catch(() => null) as { page_id?: unknown } | null;
  if (typeof body?.page_id !== 'string' || !body.page_id) return apiError('page_id is required', 400, ctx);
  const installation = await getStore().getDoc<ExtensionInstallation>(
    paths.extensionInstallation(ctx.orgId, ctx.siteId, params.installationId),
  );
  if (!installation) return apiError('Installation not found', 404, ctx);
  const version = (await resolveExtensionVersion(installation)).version;
  const page = version?.manifest.admin?.pages.find((entry) => entry.id === body.page_id);
  if (!page) return apiError('Extension page not found', 404, ctx);
  try {
    const launch = await issueExtensionLaunchGrant({
      ownerOrgId: ctx.orgId,
      siteId: ctx.siteId,
      installationId: installation.id,
      userId: `api-key:${ctx.keyPrefix}`,
      permission: ctx.permission,
      minimumPermission: page.minimum_permission,
    });
    const response = apiResponse(ctx, {
      ...launch,
      launch_url: page.launch_url,
      method: 'POST',
      form: { code: launch.code, issuer: extensionIssuer(), installation_id: installation.id, page_id: page.id },
      native: Boolean(page.native),
    }, 200, { page_id: page.id });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof ExtensionAuthError) return apiError(error.message, error.status, ctx);
    return apiError('Failed to create launch grant', 500, ctx);
  }
};
