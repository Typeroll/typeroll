import type { APIRoute } from 'astro';
import { paths, type ExtensionVersion } from '@typeroll/shared';
import { json } from '../../../../../../../lib/access';
import { getStore } from '../../../../../../../lib/datastore';
import { ExtensionRegistryError, setExtensionVersionLifecycle } from '../../../../../../../lib/extensions/registry';
import { requireDeveloperAccess } from '../../../../../../../lib/extensions/developer-access';

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  if (!params.extensionId || !params.version) return json({ error: 'Missing extension or version' }, 400);
  const version = await getStore().getDoc<ExtensionVersion>(paths.extensionVersion(access.orgId, params.extensionId, params.version));
  return version ? json({ version }) : json({ error: 'Extension version not found' }, 404);
};

export const PATCH: APIRoute = async ({ request, cookies, params }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  if (!params.extensionId || !params.version) return json({ error: 'Missing extension or version' }, 400);
  const body = await request.json().catch(() => null) as { status?: string; reason?: string } | null;
  if (body?.status !== 'deprecated' && body?.status !== 'revoked') return json({ error: 'status must be deprecated or revoked' }, 400);
  try {
    return json({ version: await setExtensionVersionLifecycle({
      developerOrgId: access.orgId,
      extensionId: params.extensionId,
      version: params.version,
      status: body.status,
      reason: body.reason,
    }) });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Version update failed' }, 500);
  }
};
