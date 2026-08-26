import type { APIRoute } from 'astro';
import { json } from '../../../../../../lib/access';
import { ExtensionRegistryError, rotateExtensionClientSecret } from '../../../../../../lib/extensions/registry';
import { requireDeveloperAccess } from '../../../../../../lib/extensions/developer-access';

export const POST: APIRoute = async ({ request, cookies, params }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  if (!params.extensionId) return json({ error: 'Missing extension id' }, 400);
  try {
    return json({ client_secret: await rotateExtensionClientSecret({ developerOrgId: access.orgId, extensionId: params.extensionId }) });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Credential rotation failed' }, 500);
  }
};
