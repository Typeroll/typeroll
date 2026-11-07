// POST /api/sites/{siteId}/packages/import   — import a package into the site
//      multipart/form-data: file (the .typeroll), options (JSON:
//      { design: "content" | "styles" | "full", fonts?, only?, font_licence_confirmed? })
//      → { report }
//
// Needs write permission; admin when options.design is "full", or when the
// import adds fonts or settings pages. Fonts need font_licence_confirmed.
// A write that fails part-way answers code "package_import_partial" with
// details.report listing what was written.

import type { APIRoute } from 'astro';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { importSitePackage, parseImportOptions } from '../../../../../lib/packages/package-import';
import { packageFailureBody, packageUpload } from '../../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const permission = requirePermission(guard.value, 'write');
  if (!permission.ok) return permission.response;
  const { session, site, owner_org_id, versionId } = guard.value;
  try {
    const upload = await packageUpload(request);
    const report = await importSitePackage({
      orgId: owner_org_id, siteId: site.id, versionId, permission: guard.value.permission, actor: session.email || session.userId,
    }, upload.bytes, parseImportOptions(upload.options));
    return json({ report });
  } catch (error) {
    const refused = packageFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
