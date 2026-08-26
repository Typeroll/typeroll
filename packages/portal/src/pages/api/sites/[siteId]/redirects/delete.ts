import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission } from '../../../../../lib/access';
import { vstore } from '../../../../../lib/version-store';

export const POST: APIRoute = async ({ request, cookies, params, redirect, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  if (!id) return new Response('id required', { status: 400 });

  await vstore.deleteRedirect(owner_org_id, site.id, versionId, id);
  return redirect(`/app/sites/${site.id}/redirects`);
};
