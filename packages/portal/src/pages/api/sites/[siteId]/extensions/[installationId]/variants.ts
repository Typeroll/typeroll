// GET /api/sites/{siteId}/extensions/{installationId}/variants?component_id=…
//
// The editor's variant picker for an app contract component: the variants
// the installed app lists (asked server side), or the single `standard` when
// it declares none. 502 when the app does not answer; the editor then falls
// back to typing the variant id. Read access is enough: picking a variant is
// page editing.

import type { APIRoute } from 'astro';
import { json, requireSiteAccess } from '../../../../../../lib/access';
import { ContractCallError, listExtensionVariants } from '../../../../../../lib/extensions/contract-calls';

export const GET: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const componentId = new URL(request.url).searchParams.get('component_id') ?? '';
  if (!params.installationId || !componentId) return json({ error: 'component_id is required' }, 400);
  try {
    return json(await listExtensionVariants(guard.value.owner_org_id, guard.value.site.id, params.installationId, componentId));
  } catch (error) {
    if (error instanceof ContractCallError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: 'The app did not list its variants', code: 'contract_app_unavailable' }, 502);
  }
};
