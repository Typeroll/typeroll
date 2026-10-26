import type { APIRoute } from 'astro';
import { json } from '../../../../../../../lib/access';
import { MAX_EXTENSION_SCRIPT_BYTES, verifyExtensionAssets } from '../../../../../../../lib/extensions/assets';
import { createSafeFetch } from '../../../../../../../lib/net/safe-fetch';
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
      verifyAssets: (manifest) => verifyExtensionAssets(manifest, createSafeFetch({ label: 'Asset URL', maxRedirects: 0, timeoutMs: 15_000, maxBytes: MAX_EXTENSION_SCRIPT_BYTES })),
    }) });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: error instanceof Error ? error.message : 'Failed to publish Extension version' }, 400);
  }
};
