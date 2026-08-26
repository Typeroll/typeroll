import type { APIRoute } from 'astro';
import { paths, type ExtensionInstallation, type ExtensionVersion } from '@typeroll/shared';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { getStore } from '../../../../../../lib/datastore';
import { ExtensionAuthError, issueExtensionLaunchGrant } from '../../../../../../lib/extensions/auth';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  if (!params.installationId) return json({ error: 'Missing installationId' }, 400);
  const body = await request.json().catch(() => null) as { page_id?: string } | null;
  if (!body?.page_id) return json({ error: 'page_id is required' }, 400);
  const installation = await getStore().getDoc<ExtensionInstallation>(
    paths.extensionInstallation(guard.value.owner_org_id, guard.value.site.id, params.installationId),
  );
  if (!installation) return json({ error: 'Installation not found' }, 404);
  const version = await getStore().getDoc<ExtensionVersion>(
    paths.extensionVersion(installation.developer_org_id, installation.extension_id, installation.version),
  );
  const page = version?.manifest.admin?.pages.find((entry) => entry.id === body.page_id);
  if (!page) return json({ error: 'Extension page not found' }, 404);
  try {
    const launch = await issueExtensionLaunchGrant({
      ownerOrgId: guard.value.owner_org_id,
      siteId: guard.value.site.id,
      installationId: installation.id,
      userId: guard.value.session.userId,
      permission: guard.value.permission,
      minimumPermission: page.minimum_permission,
    });
    return json({ ...launch, launch_url: page.launch_url });
  } catch (error) {
    if (error instanceof ExtensionAuthError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to create launch grant' }, 500);
  }
};
