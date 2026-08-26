import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation, type ExtensionScope } from '@typeroll/shared';
import { json } from '../../../../../lib/access';
import { requireApiKey } from '../../../../../lib/api-auth';
import { maskExtensionConfig } from '../../../../../lib/extensions/config';
import { ExtensionRegistryError, installExtension } from '../../../../../lib/extensions/registry';
import { getStore } from '../../../../../lib/datastore';
import { resolveExtensionVersion } from '../../../../../lib/extensions/resolution';

function canAdmin(permission: string): boolean {
  return permission === 'admin';
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (!canAdmin(guard.value.permission)) return json({ error: 'Admin permission required' }, 403);
  const installations = await getStore().listDocs<ExtensionInstallation>(
    paths.extensionInstallations(guard.value.orgId, guard.value.siteId),
  );
  const safe = await Promise.all(installations.map(async (installation) => {
    const resolution = await resolveExtensionVersion(installation);
    const version = resolution.version;
    return {
      ...installation,
      private_config: undefined,
      secret_config_enc: undefined,
      initial_version: resolution.initial_version,
      current_version: resolution.resolved_version,
      automatically_updated: resolution.automatically_updated,
      release_resolution: resolution.reason ?? 'resolved',
      config: maskExtensionConfig(version?.manifest.config_schema, installation),
      manifest: version?.manifest,
      version_status: version?.status ?? 'missing',
    };
  }));
  return json({ extensions: safe });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (!canAdmin(guard.value.permission)) return json({ error: 'Admin permission required' }, 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  try {
    const installation = await installExtension({
      developerOrgId: String(body.developer_org_id ?? guard.value.tokenOrgId),
      ownerOrgId: guard.value.orgId,
      siteId: guard.value.siteId,
      actorId: `api:${guard.value.keyPrefix}`,
      extensionId: String(body.extension_id ?? ''),
      version: String(body.version ?? ''),
      grantedScopes: Array.isArray(body.granted_scopes) ? body.granted_scopes.map(String) as ExtensionScope[] : [],
      config: body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? body.config as Record<string, unknown>
        : {},
    });
    return json({ installation: { ...installation, private_config: undefined, secret_config_enc: undefined } }, 201);
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to install Extension' }, 500);
  }
};
