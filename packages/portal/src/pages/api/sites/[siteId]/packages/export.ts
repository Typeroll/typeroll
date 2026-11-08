// POST /api/sites/{siteId}/packages/export   — download part of the site, or
//      the whole site, as a Typeroll package (.typeroll)
//      JSON: { selection, meta } → the zip (application/vnd.typeroll.package+zip,
//      attachment "<id>-<version>.typeroll"); refusals: { error, code, details? }
//
// selection: { kind: "collection" | "site", block_templates?, page_templates?,
// global_blocks?, block_types?, menus? (lists of ids or "all"), styles?
// ("used" | "all"), design?, site_fields?, fonts? ({ families,
// redistributable_confirmed: true }), demo_media? (media ids) }.
// meta: { id, name, version, description?, author?, licence?, languages? }.
// Export warnings travel in the Typeroll-Package-Warnings header (JSON,
// URI-encoded). A collection needs write permission; a whole site needs
// admin, like the content export.

import type { APIRoute } from 'astro';
import { SITE_PACKAGE_MEDIA_TYPE } from '@typeroll/shared';
import { requireSiteAccess, json, requirePermission } from '../../../../../lib/access';
import { exportSitePackage, parseExportMeta, parseExportSelection } from '../../../../../lib/packages/package-export';
import { packageFailureBody } from '../../../../../lib/packages/package-requests';

export const POST: APIRoute = async ({ request, cookies, params, locals }) => {
  const guard = await requireSiteAccess(cookies, params.siteId, locals);
  if (!guard.ok) return guard.response;
  const { site, owner_org_id, versionId } = guard.value;
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Send { selection, meta } as JSON', code: 'package_selection_invalid' }, 400);
    const selection = parseExportSelection(body.selection);
    const permission = requirePermission(guard.value, selection.kind === 'site' ? 'admin' : 'write');
    if (!permission.ok) return permission.response;
    const meta = parseExportMeta(body.meta);
    const result = await exportSitePackage({ orgId: owner_org_id, siteId: site.id, versionId }, selection, meta);
    return new Response(new Uint8Array(result.zip), {
      status: 200,
      headers: {
        'Content-Type': SITE_PACKAGE_MEDIA_TYPE,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
        'Typeroll-Package-Sha256': result.sha256,
        ...(result.warnings.length ? { 'Typeroll-Package-Warnings': encodeURIComponent(JSON.stringify(result.warnings.slice(0, 20))) } : {}),
      },
    });
  } catch (error) {
    const refused = packageFailureBody(error);
    if (!refused) throw error;
    return json(refused.body, refused.status);
  }
};
