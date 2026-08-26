// GET  /api/v1/sites/{siteId}/migration-urls   — inventory + coverage summary
// POST /api/v1/sites/{siteId}/migration-urls   — bulk add
//
// The bearer-authed twin of the in-portal migration dashboard. Coverage is
// recomputed from current pages + redirects on every read (see
// lib/wp/url-inventory.ts), so an agent that just created a redirect sees
// the URL flip from `unhandled` to `redirected` on its next call — no
// bookkeeping of its own.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../lib/api-auth';
import { getStore } from '../../../../../../lib/datastore';
import {
  addInventoryUrls,
  analyzeCoverage,
  type BulkUrlInput,
  type UrlStatus,
} from '../../../../../../lib/wp/url-inventory';

const STATUSES: UrlStatus[] = ['migrated', 'redirected', 'excluded', 'unhandled'];
const MAX_BULK = 2000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const url = new URL(request.url);
  const statusFilter = (url.searchParams.get('status') ?? '').trim();
  if (statusFilter && !STATUSES.includes(statusFilter as UrlStatus)) {
    return apiError(`status must be one of: ${STATUSES.join(', ')}`);
  }
  const limit = clamp(url.searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);

  const { urls, summary } = await analyzeCoverage(getStore(), ctx.orgId, ctx.siteId);
  const filtered = statusFilter ? urls.filter((u) => u.status === statusFilter) : urls;
  const page = filtered.slice(offset, offset + limit);

  return apiResponse(ctx, {
    // Summary always describes the WHOLE inventory, never the filtered page —
    // a paginated caller must not read "3 unhandled" off a page of 3.
    summary,
    total_matching: filtered.length,
    limit,
    offset,
    urls: page,
  });
};

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;

  const body = (await request.json().catch(() => null)) as {
    urls?: unknown;
    source?: string;
    source_origin?: string;
  } | null;
  if (!body) return apiError('Invalid JSON body');
  if (!Array.isArray(body.urls) || body.urls.length === 0) {
    return apiError('urls must be a non-empty array of { url, source?, notes?, gsc_clicks?, gsc_impressions?, excluded? }');
  }
  if (body.urls.length > MAX_BULK) {
    return apiError(`Too many urls in one call (max ${MAX_BULK}); split the batch`);
  }
  if (body.source_origin && !isHttpUrl(body.source_origin)) {
    return apiError('source_origin must be an absolute http(s) URL');
  }

  const inputs: BulkUrlInput[] = body.urls.map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    return {
      url: typeof e.url === 'string' ? e.url : typeof raw === 'string' ? raw : '',
      source: typeof e.source === 'string' ? e.source : undefined,
      notes: typeof e.notes === 'string' ? e.notes : undefined,
      gsc_clicks: typeof e.gsc_clicks === 'number' ? e.gsc_clicks : undefined,
      gsc_impressions: typeof e.gsc_impressions === 'number' ? e.gsc_impressions : undefined,
      excluded: typeof e.excluded === 'boolean' ? e.excluded : undefined,
    };
  });

  const result = await addInventoryUrls(getStore(), ctx.orgId, ctx.siteId, inputs, {
    defaultSource: typeof body.source === 'string' && body.source ? body.source : 'import',
    sourceOrigin: body.source_origin,
  });
  const { summary } = await analyzeCoverage(getStore(), ctx.orgId, ctx.siteId);

  return apiResponse(ctx, { ...result, summary }, 201, body);
};

function clamp(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw ?? '');
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
