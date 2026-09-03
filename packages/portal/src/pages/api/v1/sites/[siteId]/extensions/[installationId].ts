// Bearer-authenticated extension installation management. This mirrors the
// portal's session-authenticated installation route so automation can update
// schema-defined installation config without a browser session.

import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation, type ExtensionScope } from '@typeroll/shared';
import { json } from '../../../../../../lib/access';
import { requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { maskExtensionConfig } from '../../../../../../lib/extensions/config';
import { resolveExtensionVersion } from '../../../../../../lib/extensions/resolution';
import {
  ExtensionRegistryError,
  setExtensionInstallationStatus,
  updateExtensionInstallation,
} from '../../../../../../lib/extensions/registry';

async function load(ownerOrgId: string, siteId: string, installationId: string | undefined) {
  if (!installationId) return null;
  return getStore().getDoc<ExtensionInstallation>(
    paths.extensionInstallation(ownerOrgId, siteId, installationId),
  );
}

async function safeInstallation(installation: ExtensionInstallation) {
  const resolution = await resolveExtensionVersion(installation);
  return {
    installation: {
      ...installation,
      private_config: undefined,
      secret_config_enc: undefined,
      initial_version: resolution.initial_version,
      current_version: resolution.resolved_version,
      automatically_updated: resolution.automatically_updated,
      release_resolution: resolution.reason ?? 'resolved',
    },
    config: maskExtensionConfig(resolution.version?.manifest.config_schema, installation),
    manifest: resolution.version?.manifest,
    // Extension public config and provisioned component definitions are
    // materialized into the static build snapshot. Keep publishing explicit,
    // but make the required follow-up machine-readable for API/MCP clients.
    affects_build: true,
    redeploy_required: true,
  };
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return json({ error: 'Admin permission required' }, 403);
  const installation = await load(guard.value.orgId, guard.value.siteId, params.installationId);
  if (!installation) return json({ error: 'Installation not found' }, 404);
  return json(await safeInstallation(installation));
};

export const PATCH: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  if (guard.value.permission !== 'admin') return json({ error: 'Admin permission required' }, 403);
  if (!params.installationId) return json({ error: 'Missing installationId' }, 400);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);

  try {
    if (body.status === 'enabled' || body.status === 'disabled') {
      await setExtensionInstallationStatus({
        ownerOrgId: guard.value.orgId,
        siteId: guard.value.siteId,
        installationId: params.installationId,
        actorId: `api:${guard.value.keyPrefix}`,
        status: body.status,
      });
    }
    const installation = await updateExtensionInstallation({
      ownerOrgId: guard.value.orgId,
      siteId: guard.value.siteId,
      installationId: params.installationId,
      actorId: `api:${guard.value.keyPrefix}`,
      version: typeof body.version === 'string' ? body.version : undefined,
      grantedScopes: Array.isArray(body.granted_scopes)
        ? body.granted_scopes.map(String) as ExtensionScope[]
        : undefined,
      config: body.config && typeof body.config === 'object' && !Array.isArray(body.config)
        ? body.config as Record<string, unknown>
        : undefined,
    });
    return json(await safeInstallation(installation));
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to update Extension installation' }, 500);
  }
};
