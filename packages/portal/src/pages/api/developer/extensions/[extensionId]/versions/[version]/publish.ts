import type { APIRoute } from 'astro';
import { json } from '../../../../../../../lib/access';
import { verifyExtensionAssets } from '../../../../../../../lib/extensions/assets';
import { ExtensionRegistryError, publishExtensionVersion } from '../../../../../../../lib/extensions/registry';
import { requireDeveloperAccess } from '../../../../../../../lib/extensions/developer-access';

export const POST: APIRoute = async ({ request, cookies, params }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  if (!params.extensionId || !params.version) return json({ error: 'Missing extension or version' }, 400);
  try {
    return json({ version: await publishExtensionVersion({
      developerOrgId: access.orgId,
      extensionId: params.extensionId,
      version: params.version,
      verifyAssets: verifyExtensionAssets,
    }) });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: error instanceof Error ? error.message : 'Failed to publish Extension version' }, 400);
  }
};
