import type { APIRoute } from 'astro';
import { paths, type Extension } from '@typeroll/shared';
import { json } from '../../../../lib/access';
import { getStore } from '../../../../lib/datastore';
import { createExtension, ExtensionRegistryError } from '../../../../lib/extensions/registry';
import { requireDeveloperAccess } from '../../../../lib/extensions/developer-access';

export const GET: APIRoute = async ({ request, cookies }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  const extensions = await getStore().listDocs<Extension>(paths.extensions(access.orgId));
  return json({ extensions: extensions.map(({ client_secret_hash: _secret, ...extension }) => extension) });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Invalid JSON body' }, 400);
  try {
    const result = await createExtension({
      developerOrgId: access.orgId,
      actorId: access.actorId,
      id: String(body.id ?? ''),
      name: String(body.name ?? ''),
      distribution: body.distribution as Extension['distribution'] | undefined,
      trustedOrigins: Array.isArray(body.trusted_origins) ? body.trusted_origins.map(String) : [],
      allowedOrgIds: Array.isArray(body.allowed_org_ids) ? body.allowed_org_ids.map(String) : undefined,
      allowedSiteIds: Array.isArray(body.allowed_site_ids) ? body.allowed_site_ids.map(String) : undefined,
    });
    return json(result, 201);
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to create Extension' }, 500);
  }
};
