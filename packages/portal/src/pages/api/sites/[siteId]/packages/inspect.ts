// POST /api/sites/{siteId}/packages/inspect   — what importing a package would do
//      multipart/form-data: file (the .typeroll), options? (JSON:
//      { design: "content" | "styles" | "full", fonts?, only?, font_licence_confirmed? })
//      → { package, signature, plan, warnings, errors, needs }
//
// Reads and verifies the package and plans the import against the site's
// current state; writes nothing, so read access is enough. `errors` lists what would stop the import;
// `needs` says whether it requires admin and a font licence confirmation.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json } from '../../../../../lib/access';
import { inspectSitePackage, parseImportOptions } from '../../../../../lib/packages/package-import';
import { packageFailureBody, packageUpload } from '../../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id, versionId } = guard.value;
  try {
    const upload = await packageUpload(request);
    return json(await inspectSitePackage(owner_org_id, site.id, versionId, upload.bytes, parseImportOptions(upload.options)));
  } catch (error) {
    const refused = packageFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
