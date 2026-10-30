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
import type { ParityVerdict } from '../../../../../../lib/wp/url-parity';
import type { UrlStatus } from '../../../../../../lib/wp/url-inventory';
import { migrationSourcePolicy, parseOutboundUrl } from '../../../../../../lib/net/safe-fetch';

const STATUSES: UrlStatus[] = ['migrated', 'redirected', 'excluded', 'unhandled', 'matched_draft'];
const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 500;
const MAX_CONCURRENCY = 12;
const VERDICTS: ParityVerdict[] = [
  'ok', 'ok_redirect', 'missing', 'broken_redirect', 'error', 'excluded',
];
const DEFAULT_RESULT_VERDICTS: ParityVerdict[] = ['missing', 'broken_redirect', 'error'];

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const body = (await request.json().catch(() => ({}))) as {
    target_origin?: string;
    source_origin?: string;
    check_source?: boolean;
    statuses?: string[];
    verdicts?: string[];
    include_successes?: boolean;
    limit?: number;
    concurrency?: number;
  };

  if (body.target_origin && !isHttpUrl(body.target_origin)) {
    return apiError('target_origin must be an absolute public http(s) URL');
  }
  if (body.source_origin && !isHttpUrl(body.source_origin)) {
    return apiError('source_origin must be an absolute public http(s) URL');
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
  let verdicts: ParityVerdict[] | undefined;
  if (body.verdicts !== undefined) {
    if (!Array.isArray(body.verdicts) || body.verdicts.some((value) => !VERDICTS.includes(value as ParityVerdict))) {
      return apiError(`verdicts must be an array of: ${VERDICTS.join(', ')}`);
    }
    verdicts = body.verdicts as ParityVerdict[];
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
    const selectedVerdicts = verdicts ?? (
      body.include_successes === true ? VERDICTS : DEFAULT_RESULT_VERDICTS
    );
    const results = report.results.filter((result) => selectedVerdicts.includes(result.verdict));
    const gaps = results.filter(
      (result) => result.verdict === 'missing' || result.verdict === 'broken_redirect',
    );
    return apiResponse(ctx, {
      ...report,
      results,
      returned_results: results.length,
      omitted_results: report.results.length - results.length,
      result_verdicts: selectedVerdicts,
      gaps,
      // Launch evidence needs one complete, unfiltered check; a truncated call
      // cannot store it. The url_parity workflow checks the whole inventory.
      ...(report.truncated ? { evidence_stored: false, next_step: {
        message: `This call checked ${report.checked} of ${report.inventory_total} inventory URLs (limit ${MAX_LIMIT}), so it stored no launch evidence. Start the url_parity workflow to check every URL and record evidence for the launch report.`,
        workflow: 'url_parity', config: { ...(body.target_origin ? { target_origin: body.target_origin } : {}), ...(body.source_origin ? { source_origin: body.source_origin } : {}) },
      } } : { evidence_stored: !statuses?.length }),
    }, 200, {
      target_origin: body.target_origin,
      source_origin: body.source_origin,
      check_source: body.check_source,
      statuses: body.statuses,
      verdicts: body.verdicts,
      include_successes: body.include_successes,
      limit,
      concurrency,
    });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'Parity check failed', 400);
  }
};

/** Absolute http(s) URL whose host is not local or a non-public IP literal.
 * Host names are re-checked against DNS on every request. */
function isHttpUrl(s: string): boolean {
  try {
    parseOutboundUrl(s, migrationSourcePolicy());
    return true;
  } catch {
    return false;
  }
}
