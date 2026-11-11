import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation } from '@typeroll/shared';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { resolveExtensionVersion } from '../../../../../../lib/extensions/resolution';
import { versionedExtensionInstallation } from '../../../../../../lib/extensions/version-config';
import { buildExtensionConfig } from '../../../../../../lib/extensions/config';
import { extensionSiteOrigins } from '../../../../../../lib/extensions/public-token';
import { publishedExtensionVersion } from '../../../../../../lib/extensions/published-version';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (!ctx.extensionIdentity) return apiError('An installation credential is required', 403);
  const installation = await getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(ctx.orgId, ctx.siteId, ctx.extensionIdentity.installationId));
  if (!installation || installation.status !== 'enabled') return apiError('Installation unavailable', 404);
  const version = (await resolveExtensionVersion(installation)).version;
  if (!version) return apiError('Release unavailable', 409);
  const effective = await versionedExtensionInstallation(installation, version.manifest.config_schema, ctx.versionId);
  const config = buildExtensionConfig(version.manifest.config_schema, {}, effective);
  if (typeof config === 'string') return apiError('Installation configuration is invalid', 409);
  // `version` is what the app API runs now; `published_version` is what live pages call until the next
  // publication activates (null when unknown). A versioned app Worker keeps serving the published one.
  // `contract` is the app contract the installation is bound to (null without one); it, not the version, selects the app's address.
  const response = apiResponse(ctx, { installation_id: installation.id, extension_id: installation.extension_id, version: version.version,
    contract: installation.contract ?? null,
    published_version: await publishedExtensionVersion(ctx.orgId, ctx.siteId, installation.id, ctx.versionId), status: installation.status, config: { ...config.public_config, ...config.private_config },
    origins: [...await extensionSiteOrigins(ctx.orgId, ctx.siteId)], scopes: ctx.extensionIdentity.scopes });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
