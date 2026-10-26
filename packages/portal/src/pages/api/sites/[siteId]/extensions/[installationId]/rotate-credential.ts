import type { APIRoute } from 'astro';
import { json, requireOwnerPermission, requireSiteAccess } from '../../../../../../lib/access';
import { ExtensionAuthError, rotateInstallationCredential } from '../../../../../../lib/extensions/auth';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  // The credential is stored under the owner and outlives any share, so a
  // share recipient cannot mint one.
  const admin = requireOwnerPermission(guard.value, 'admin', 'Only the owning organization can issue Extension credentials');
  if (!admin.ok) return admin.response;
  if (!params.installationId) return json({ error: 'Missing installationId' }, 400);
  const body = await request.json().catch(() => ({})) as { grace_seconds?: number };
  try {
    return json(await rotateInstallationCredential({
      ownerOrgId: guard.value.owner_org_id,
      siteId: guard.value.site.id,
      installationId: params.installationId,
      actorId: guard.value.session.userId,
      graceSeconds: Number.isFinite(body.grace_seconds) ? Number(body.grace_seconds) : undefined,
    }));
  } catch (error) {
    if (error instanceof ExtensionAuthError) return json({ error: error.message }, error.status);
    return json({ error: 'Failed to rotate credential' }, 500);
  }
};
