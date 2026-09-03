// POST /api/v1/sites/{siteId}/migration-urls/import-gsc
// Import page metrics directly from Search Console or from its CSV export.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { aggregateGscMetrics, fetchGscMetrics, parseGscCsv } from '../../../../../../lib/wp/gsc-import';
import { addInventoryUrls, analyzeCoverage, makeUrlId } from '../../../../../../lib/wp/url-inventory';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as {
    property?: string;
    months?: number;
    csv?: string;
    source_origin?: string;
  } | null;
  if (!body) return apiError('Invalid JSON body');
  if ((typeof body.csv === 'string') === (typeof body.property === 'string')) {
    return apiError('Provide exactly one of csv or property');
  }

  let sourceOrigin = body.source_origin;
  if (!sourceOrigin && body.property?.startsWith('http')) {
    try { sourceOrigin = new URL(body.property).origin; } catch { /* validated below */ }
  }
  if (sourceOrigin) {
    try { sourceOrigin = new URL(sourceOrigin).origin; }
    catch { return apiError('source_origin must be an absolute URL'); }
  }

  try {
    const metrics = aggregateGscMetrics(
      typeof body.csv === 'string'
        ? parseGscCsv(body.csv)
        : await fetchGscMetrics({ property: body.property!, months: body.months }),
    );
    const imported = await addInventoryUrls(
      getStore(),
      ctx.orgId,
      ctx.siteId,
      metrics.map((row) => ({
        url: row.url,
        source: 'gsc',
        gsc_clicks: row.clicks,
        gsc_impressions: row.impressions,
      })),
      { defaultSource: 'gsc', sourceOrigin },
    );
    const coverage = await analyzeCoverage(getStore(), ctx.orgId, ctx.siteId);
    const importedIds = new Set(metrics.map((row) => {
      try {
        const parsed = row.url.startsWith('/') ? row.url : `${new URL(row.url).pathname}${new URL(row.url).search}`;
        return makeUrlId(parsed.replace(/\/$/, '') || '/');
      } catch { return ''; }
    }));
    const newlyUnhandled = coverage.urls.filter(
      (entry) => importedIds.has(entry.id) && entry.status === 'unhandled',
    );
    return apiResponse(ctx, {
      mode: typeof body.csv === 'string' ? 'csv' : 'api',
      property: body.property,
      source_origin: sourceOrigin,
      rows: metrics.length,
      ...imported,
      unhandled_imported: newlyUnhandled.length,
      unhandled_urls: newlyUnhandled.map((entry) => entry.path),
      coverage: coverage.summary,
    }, 200, {
      mode: typeof body.csv === 'string' ? 'csv' : 'api',
      property: body.property,
      rows: metrics.length,
      added: imported.added,
      merged: imported.merged,
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'GSC import failed', 400);
  }
};
