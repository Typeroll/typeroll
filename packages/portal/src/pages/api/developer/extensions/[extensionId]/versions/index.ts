import type { APIRoute } from 'astro';
import { paths, type ExtensionVersion } from '@typeroll/shared';
import { json } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { ExtensionRegistryError, saveExtensionVersion } from '../../../../../../lib/extensions/registry';
import { requireDeveloperAccess } from '../../../../../../lib/extensions/developer-access';

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  if (!params.extensionId) return json({ error: 'Missing extensionId' }, 400);
  return json({ versions: await getStore().listDocs<ExtensionVersion>(paths.extensionVersions(access.orgId, params.extensionId)) });
};

export const POST: APIRoute = async ({ request, cookies, params }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  if (!params.extensionId) return json({ error: 'Missing extensionId' }, 400);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  const manifest = typeof body === 'object' && body && 'manifest' in body ? (body as { manifest: unknown }).manifest : body;
  try {
    return json({ version: await saveExtensionVersion({
      developerOrgId: access.orgId,
      extensionId: params.extensionId,
      actorId: access.actorId,
      manifest,
    }) }, 201);
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to save Extension version' }, 500);
  }
};
