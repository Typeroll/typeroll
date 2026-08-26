// POST /api/v1/sites/{siteId}/bulk-replace
//
// Body: { pattern, replacement, regex?, page_ids?, dry_run? }
//
// Wraps lib/bulk-operations.bulkReplaceText. Agents should always send
// dry_run: true on the first call and surface the sample_diffs to the user
// before re-calling without dry_run. Writes go through vstore.writePage so
// SEO transforms + revision snapshots happen the same as in the editor.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../lib/api-auth';
import { bulkReplaceText } from '../../../../../lib/bulk-operations';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as {
    pattern?: string;
    replacement?: string;
    regex?: boolean;
    page_ids?: string[];
    dry_run?: boolean;
    /** Commit each touched page's working copy in the same call. */
    save?: boolean;
  } | null;
  if (!body) return apiError('Invalid JSON body');
  if (typeof body.pattern !== 'string' || !body.pattern) return apiError('pattern required');
  if (typeof body.replacement !== 'string') return apiError('replacement required');

  try {
    const r = await bulkReplaceText(ctx.orgId, ctx.siteId, ctx.versionId, {
      pattern: body.pattern,
      replacement: body.replacement,
      regex: Boolean(body.regex),
      pageIds: Array.isArray(body.page_ids) ? body.page_ids : undefined,
      dryRun: Boolean(body.dry_run),
      save: Boolean(body.save),
      updatedBy: `api-key:${ctx.keyPrefix}`,
    });
    // Audit preview summarises pattern + counts so a leaked log doesn't
    // also leak full page bodies.
    const audit = {
      pattern: body.pattern.slice(0, 60),
      regex: !!body.regex,
      dry_run: !!body.dry_run,
      updated: r.updated,
      matches: r.total_matches,
    };
    return apiResponse(ctx, r, 200, audit);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'Bulk replace failed', 400);
  }
};
