import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { resolveExtensionVersion } from '../../../../../../lib/extensions/resolution';
import { buildExtensionConfig } from '../../../../../../lib/extensions/config';
import { extensionSiteOrigins } from '../../../../../../lib/extensions/public-token';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity) return apiError('An installation credential is required', 403);
  const installation = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(ctx.orgId, ctx.siteId, ctx.extensionIdentity.installationId));
  if (!installation || installation.status !== 'enabled') return apiError('Installation unavailable', 404);
  const version = (await resolveExtensionVersion(installation)).version;
  if (!version) return apiError('Release unavailable', 409);
  const config = buildExtensionConfig(version.manifest.config_schema, {}, installation);
  if (typeof config === 'string') return apiError('Installation configuration is invalid', 409);
  const response = apiResponse(ctx, { installation_id: installation.id, extension_id: installation.extension_id, version: version.version,
    status: installation.status, config: { ...config.public_config, ...config.private_config },
    origins: [...await extensionSiteOrigins(ctx.orgId, ctx.siteId)], scopes: ctx.extensionIdentity.scopes });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
