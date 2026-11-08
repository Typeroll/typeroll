import type { APIRoute } from 'astro';
import { json, requireOwnerPermission, requireSiteAccess } from '../../../../../../../lib/access';
import { provisionInstallationCredential } from '../../../../../../../lib/extensions/credential-provisioning';
import { ExtensionRegistryError } from '../../../../../../../lib/extensions/registry';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requireOwnerPermission(guard.value, 'admin', 'Only the owning organization can connect Extensions');
  if (!admin.ok) return admin.response;
  if (!params.installationId) return json({ error: 'Missing installation id' }, 400);
  try {
    const result = await provisionInstallationCredential({
      ownerOrgId: guard.value.owner_org_id,
      siteId: guard.value.site.id,
      installationId: params.installationId,
      actorId: guard.value.session.userId,
    });
    return json({ status: 'connected', ...result });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Connecting the Extension failed' }, 500);
  }
};
