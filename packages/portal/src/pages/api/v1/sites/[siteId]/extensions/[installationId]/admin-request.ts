import type { APIRoute } from 'astro';
import { effectiveExtensionScopes, paths, type ExtensionInstallation } from '@typeroll/shared';
import { requireApiKey, apiError, apiResponse } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { approvedNativeAdmin } from '../../../../../../../lib/extensions/native-admin';
import { resolveExtensionVersion } from '../../../../../../../lib/extensions/resolution';
import { extensionIssuer, signDelegatedExtensionToken } from '../../../../../../../lib/extensions/auth';
import { adminDestination, requestApprovedAdmin, type AdminRequest } from '../../../../../../../lib/extensions/admin-request';

/** The app's own admin API, with the same approved release and identity as the portal. */
export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.permission !== 'admin' || ctx.extensionIdentity) return apiError('Site administrator access is required', 403);
  if (!params.installationId) return apiError('Installation is required', 400);
  const installation = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(ctx.orgId, ctx.siteId, params.installationId));
  if (!installation || installation.status !== 'enabled') return apiError('App unavailable', 404);
  const version = (await resolveExtensionVersion(installation)).version;
  const input = await request.json().catch(() => null) as AdminRequest | null;
  const page = version?.manifest.admin?.pages.find(item => item.id === input?.page_id);
  if (!version || !page?.native || !await approvedNativeAdmin(installation, version)) return apiError('This app release is not approved for portal integration', 403);
  let url: URL;
  try { url = adminDestination(page.native.api_base_url, input!); }
  catch (error) { return apiError(error instanceof Error ? error.message : 'Invalid app request', 400); }
  const signed = signDelegatedExtensionToken({ token_use: 'portal_admin', page_id: page.id, version: version.version,
    aud: installation.extension_id, sub: `api-key:${ctx.keyPrefix}`, org_id: ctx.orgId, site_id: ctx.siteId,
    installation_id: installation.id, permission: ctx.permission, scopes: effectiveExtensionScopes(installation.granted_scopes, ctx.permission) });
  try {
    const result = await requestApprovedAdmin(url, input!, signed.token, extensionIssuer());
    const response = apiResponse(ctx, result.data, result.status);
    response.headers.set('Cache-Control', 'private, no-store'); return response;
  } catch { return apiError('The approved app endpoint could not complete this request. Read its status before retrying a write.', 502); }
};
