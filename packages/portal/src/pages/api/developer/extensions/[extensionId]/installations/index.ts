import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation } from '@typeroll/shared';
import { json } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { requireDeveloperAccess } from '../../../../../../lib/extensions/developer-access';

export const GET: APIRoute = async ({ request, cookies, params, url }) => {
  const access = await requireDeveloperAccess(request, cookies);
  if (!access.ok) return access.response;
  if (!params.extensionId) return json({ error: 'Missing extension id' }, 400);
  // Datastore collections are site-scoped, so the developer must identify the
  // customer installation. We return only operational metadata, never config.
  const ownerOrgId = url.searchParams.get('owner_org_id');
  const siteId = url.searchParams.get('site_id');
  if (!ownerOrgId || !siteId) return json({ error: 'owner_org_id and site_id are required' }, 400);
  const installations = (await getStore().listDocs<ExtensionInstallation>(paths.extensionInstallations(ownerOrgId, siteId)))
    .filter((installation) => installation.extension_id === params.extensionId && installation.developer_org_id === access.orgId)
    .map(({ private_config: _private, secret_config_enc: _secret, public_config: _public, ...installation }) => installation);
  return json({ installations });
};
