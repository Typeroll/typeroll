import type { APIRoute } from 'astro';
import { requireSiteAccess, requirePermission, json } from '../../../../../lib/access';
import { createPage } from '../../../../../lib/page-create';
import { WorkingCopyError } from '../../../../../lib/working-copy';

export const POST: APIRoute = async ({ request, cookies, redirect, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const writeCheck = requirePermission(guard.value, 'write');
  if (!writeCheck.ok) return writeCheck.response;
  const { session, site, versionId, owner_org_id } = guard.value;

  const form = await request.formData();
  try {
    const { page } = await createPage({ orgId: owner_org_id, siteId: site.id, versionId }, {
      title: String(form.get('title') ?? ''), content_type: String(form.get('content_type') ?? 'page'),
      content_mode: form.get('content_mode') === 'html' ? 'html' : 'blocks',
    }, 'portal', session.email ?? 'portal');
    return redirect(`/app/sites/${site.id}/pages/${page.id}`);
  } catch (error) {
    if (error instanceof WorkingCopyError) return json({ error: error.message }, error.status);
    throw error;
  }
};
