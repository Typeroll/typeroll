// POST /api/v1/sites/{siteId}/migration-urls/import-sitemap
// Import one explicit sitemap URL, recursively following sitemap indexes.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import { addInventoryUrls, analyzeCoverage } from '../../../../../../lib/wp/url-inventory';
import { readSitemap } from '../../../../../../lib/wp/sitemap';
import { assertPublicDestination, parsePublicHttpsUrl } from '../../../../../../lib/extensions/public-http';

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const body = (await request.json().catch(() => null)) as {
    url?: string;
    sitemap_url?: string;
    source_origin?: string;
  } | null;
  const sitemapUrl = body?.url ?? body?.sitemap_url;
  if (!body || typeof sitemapUrl !== 'string') return apiError('url required');

  let sourceOrigin: string;
  try {
    const sitemap = parsePublicHttpsUrl(sitemapUrl, 'url');
    sourceOrigin = body.source_origin
      ? parsePublicHttpsUrl(body.source_origin, 'source_origin').origin
      : sitemap.origin;
  } catch {
    return apiError('url and source_origin must be public HTTPS URLs');
  }

  try {
    const sitemap = await readSitemap(sitemapUrl, {
      validateUrl: async (url) => {
        const publicUrl = parsePublicHttpsUrl(url.toString(), 'Sitemap URL');
        await assertPublicDestination(publicUrl);
      },
    });
    const imported = await addInventoryUrls(
      getStore(),
      ctx.orgId,
      ctx.siteId,
      sitemap.urls.map((entry) => ({
        url: entry.loc,
        source: 'sitemap',
        ...(entry.lastmod ? { notes: `sitemap lastmod: ${entry.lastmod}` } : {}),
      })),
      { defaultSource: 'sitemap', sourceOrigin },
    );
    const coverage = await analyzeCoverage(getStore(), ctx.orgId, ctx.siteId);
    return apiResponse(ctx, {
      url: sitemapUrl,
      source_origin: sourceOrigin,
      discovered: sitemap.urls.length,
      sitemaps_read: sitemap.sitemaps_read,
      truncated: sitemap.truncated,
      sitemap_errors: sitemap.errors,
      ...imported,
      coverage: coverage.summary,
    }, 200, {
      url: sitemapUrl,
      source_origin: sourceOrigin,
      discovered: sitemap.urls.length,
      added: imported.added,
      merged: imported.merged,
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Sitemap import failed', 400);
  }
};
