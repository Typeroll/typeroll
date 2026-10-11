import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation, type ExtensionScope } from '@typeroll/shared';
import { json, requirePermission, requireSiteAccess, resolveRequestedVersion, unknownVersionResponse } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { versionedExtensionInstallation } from '../../../../../../lib/extensions/version-config';
import { maskExtensionConfig } from '../../../../../../lib/extensions/config';
import { resolveExtensionVersion } from '../../../../../../lib/extensions/resolution';
import {
  ExtensionRegistryError,
  setExtensionInstallationStatus,
  uninstallExtension,
  updateExtensionInstallation,
} from '../../../../../../lib/extensions/registry';

async function load(ownerOrgId: string, siteId: string, installationId: string | undefined) {
  if (!installationId) return null;
  return getStore().getDoc<ExtensionInstallation>(paths.extensionInstallation(ownerOrgId, siteId, installationId));
}

export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const selected = await resolveRequestedVersion(guard.value.owner_org_id, guard.value.site.id,
    new URL(request.url).searchParams.get('version') ?? guard.value.versionId);
  if (!selected.ok) return unknownVersionResponse(selected.requested);
  let installation = await load(guard.value.owner_org_id, guard.value.site.id, params.installationId);
  if (!installation) return json({ error: 'Installation not found' }, 404);
  const resolution = await resolveExtensionVersion(installation);
  const version = resolution.version;
  installation = await versionedExtensionInstallation(installation, version?.manifest.config_schema, selected.versionId);
  return json({
    installation: {
      ...installation,
      private_config: undefined,
      secret_config_enc: undefined,
      initial_version: resolution.initial_version,
      current_version: resolution.resolved_version,
      automatically_updated: resolution.automatically_updated,
      release_resolution: resolution.reason ?? 'resolved',
      pending_activation_version: resolution.pending_activation_version,
      pending_activation_manifest: resolution.pending_activation_manifest,
    },
    config: maskExtensionConfig(version?.manifest.config_schema, installation),
    manifest: version?.manifest,
  });
};

export const PATCH: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const selected = await resolveRequestedVersion(guard.value.owner_org_id, guard.value.site.id,
    new URL(request.url).searchParams.get('version') ?? guard.value.versionId);
  if (!selected.ok) return unknownVersionResponse(selected.requested);
  if (!params.installationId) return json({ error: 'Missing installationId' }, 400);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  try {
    if (selected.versionId !== 'main' && body.status !== undefined) throw new ExtensionRegistryError('Manage installation status on main.');
    if (body.status === 'enabled' || body.status === 'disabled') {
      await setExtensionInstallationStatus({
        ownerOrgId: guard.value.owner_org_id,
        siteId: guard.value.site.id,
        installationId: params.installationId,
        actorId: guard.value.session.userId,
        status: body.status,
      });
    }
    const installation = await updateExtensionInstallation({
      siteVersionId: selected.versionId,
      ownerOrgId: guard.value.owner_org_id,
      siteId: guard.value.site.id,
      installationId: params.installationId,
      actorId: guard.value.session.userId,
      version: typeof body.version === 'string' ? body.version : undefined,
      grantedScopes: Array.isArray(body.granted_scopes) ? body.granted_scopes.map(String) as ExtensionScope[] : undefined,
      config: body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? body.config as Record<string, unknown>
        : undefined,
    });
    return json({ installation: { ...installation, private_config: undefined, secret_config_enc: undefined } });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to update Extension installation' }, 500);
  }
};

export const DELETE: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  const selected = await resolveRequestedVersion(guard.value.owner_org_id, guard.value.site.id,
    new URL(request.url).searchParams.get('version') ?? guard.value.versionId);
  if (!selected.ok) return unknownVersionResponse(selected.requested);
  if (!params.installationId) return json({ error: 'Missing installationId' }, 400);
  if (selected.versionId !== 'main') return json({ error: 'Uninstall Extensions on main.' }, 400);
  try {
    await uninstallExtension({
      ownerOrgId: guard.value.owner_org_id,
      siteId: guard.value.site.id,
      installationId: params.installationId,
      actorId: guard.value.session.userId,
    });
    return json({ ok: true });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to uninstall Extension' }, 500);
  }
};
