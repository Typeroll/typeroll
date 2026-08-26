// POST /api/v1/sites/{siteId}/migration-urls/verify
//
// Run the pre-cutover parity check synchronously and return the report. The
// agent-facing twin of the `url_parity` workflow: same lib, no polling.
//
// Synchronous because the caller is an agent mid-migration that needs the
// gap list to act on it. The default cap keeps a single request inside a
// sane request budget; `truncated: true` tells the caller to page through
// the rest rather than assume it saw everything.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { runSiteParityCheck } from '../../../../../../lib/wp/url-parity';
import type { UrlStatus } from '../../../../../../lib/wp/url-inventory';

const STATUSES: UrlStatus[] = ['migrated', 'redirected', 'excluded', 'unhandled'];
const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 500;
const MAX_CONCURRENCY = 12;

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const body = (await request.json().catch(() => ({}))) as {
    target_origin?: string;
    source_origin?: string;
    check_source?: boolean;
    statuses?: string[];
    limit?: number;
    concurrency?: number;
  };

  if (body.target_origin && !isHttpUrl(body.target_origin)) {
    return apiError('target_origin must be an absolute http(s) URL');
  }
  if (body.source_origin && !isHttpUrl(body.source_origin)) {
    return apiError('source_origin must be an absolute http(s) URL');
  }
  if (body.check_source && !body.source_origin) {
    return apiError('check_source requires source_origin');
  }
  let statuses: UrlStatus[] | undefined;
  if (body.statuses !== undefined) {
    if (!Array.isArray(body.statuses) || body.statuses.some((s) => !STATUSES.includes(s as UrlStatus))) {
      return apiError(`statuses must be an array of: ${STATUSES.join(', ')}`);
    }
    statuses = body.statuses as UrlStatus[];
  }

  const limit = Math.min(
    Math.max(1, Math.floor(Number(body.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const concurrency = Math.min(
    Math.max(1, Math.floor(Number(body.concurrency ?? 6)) || 6),
    MAX_CONCURRENCY,
  );

  try {
    const report = await runSiteParityCheck({
      store: getStore(),
      orgId: ctx.orgId,
      siteId: ctx.siteId,
      versionId: ctx.versionId,
      site: ctx.site,
      targetOrigin: body.target_origin,
      sourceOrigin: body.source_origin,
      checkSource: body.check_source === true,
      statuses,
      limit,
      concurrency,
    });
    const gaps = report.results.filter(
      (r) => r.verdict === 'missing' || r.verdict === 'broken_redirect',
    );
    return apiResponse(ctx, { ...report, gaps }, 200, body);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'Parity check failed', 400);
  }
};

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
