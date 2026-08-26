import type { APIRoute } from 'astro';
import { json, requirePermission, requireSiteAccess } from '../../../../../../../lib/access';
import { ExtensionRegistryError } from '../../../../../../../lib/extensions/registry';
import { pairExtensionIssuer } from '../../../../../../../lib/extensions/trust-pairing';

export const POST: APIRoute = async ({ cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const admin = requirePermission(guard.value, 'admin');
  if (!admin.ok) return admin.response;
  if (!params.installationId) return json({ error: 'Missing installation id' }, 400);
  try {
    const issuer = await pairExtensionIssuer({
      ownerOrgId: guard.value.owner_org_id,
      siteId: guard.value.site.id,
      installationId: params.installationId,
      actorId: guard.value.session.userId,
    });
    return json({ issuer });
  } catch (error) {
    if (error instanceof ExtensionRegistryError) return json({ error: error.message }, error.status);
    return json({ error: 'Issuer pairing failed' }, 500);
  }
};
