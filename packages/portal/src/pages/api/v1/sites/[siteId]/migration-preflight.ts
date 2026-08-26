// GET /api/v1/sites/{siteId}/migration-preflight[?source_url=https://old.example.com]
//
// Is this site ready to receive a migration? Read-only, cheap, and the
// intended FIRST call of any import job — every blocker it reports is one
// that lets the migration appear to succeed while being quietly wrong
// (images still served by the old host, deploys that publish nothing).

import type { APIRoute } from 'astro';
import { apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { runMigrationPreflight } from '../../../../../lib/migration-preflight';

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  // ?source_url probes the site being migrated FROM as well: an old host
  // that 403s our requests produces empty imported pages, and that is worth
  // knowing before the content work, not during it.
  const sourceUrl = new URL(request.url).searchParams.get('source_url')?.trim() || undefined;
  const report = await runMigrationPreflight(ctx.orgId, ctx.siteId, ctx.versionId, { sourceUrl });
  return apiResponse(ctx, report);
};
