// POST /api/v1/sites/{siteId}/packages/export   — export part of the site, or
//      the whole site, as a Typeroll package
//      JSON: { selection, meta } (as POST /api/sites/{siteId}/packages/export)
//      → { download_url, filename, bytes, sha256, expires_at, warnings }
//
// The package is stored privately for one hour; download_url is a signed
// address that needs no API key (GET .../packages/downloads/{token}). A
// collection needs write permission; a whole site (kind "site") admin.
// Extension installation credentials cannot export.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { exportSitePackage, parseExportMeta, parseExportSelection } from '../../../../../../lib/packages/package-export';
import { packageDownloadUrl, storePackageDownload } from '../../../../../../lib/packages/package-download';
import { packageApiFailure } from '../../../../../../lib/packages/package-api';
import { templatesDesignFindings } from '../../../../../../lib/design-token-audit';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  if (ctx.extensionIdentity) return apiError('Extension credentials cannot export packages', 403, ctx);
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('Send { selection, meta } as JSON', 400, ctx, { code: 'package_selection_invalid' });
    const selection = parseExportSelection(body.selection);
    const required = selection.kind === 'site' ? 'admin' : 'write';
    if (ctx.permission === 'read' || (required === 'admin' && ctx.permission !== 'admin')) return apiError(`Insufficient permission (${required} required)`, 403, ctx);
    const meta = parseExportMeta(body.meta);
    const result = await exportSitePackage({ orgId: ctx.orgId, siteId: ctx.siteId, versionId: ctx.versionId }, selection, meta);
    const stored = await storePackageDownload(ctx.orgId, ctx.siteId, result);
    return apiResponse(ctx, {
      download_url: packageDownloadUrl(request, ctx.siteId, stored.token), filename: result.filename, bytes: result.zip.byteLength,
      sha256: result.sha256, expires_at: stored.expires_at, warnings: result.warnings,
      // Hard-coded colours and fonts in the exported block templates (non-blocking).
      design_findings: await templatesDesignFindings(ctx, result.manifest.contents.block_templates ?? []),
    }, 200, body);
  } catch (error) { return packageApiFailure(error, ctx); }
};
