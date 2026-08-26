// POST /api/v1/sites/{siteId}/collections/{name}/regenerate-listing
//
// Swaps a marker-delimited section in a page body with freshly-rendered
// HTML built from the collection's current published items. Solves the
// "I hand-wrote a list of blog posts into the homepage and now it's
// stale" problem: instead of asking the agent to read_page + diff +
// update_page every time, the tool finds the markers, fetches the
// items, fills the template, and writes back atomically.
//
// Marker convention (chosen so it survives the HTML sanitizer + is
// agent-paste-stable):
//
//   <!-- typeroll:listing:{name} -->
//   ...whatever was here gets replaced...
//   <!-- /typeroll:listing:{name} -->
//
// The agent's first call to this tool on a virgin page will fail with
// "markers not found"; the agent then adds the marker pair to the page
// body once, and every subsequent call updates the section in-place.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { vstore } from '../../../../../../../lib/version-store';
import { effectiveRouteTemplate, resolveItemPath } from '@typeroll/shared';
import type { CollectionDef, CollectionItem, Page } from '@typeroll/shared';

interface RegenBody {
  page_id?: string;
  /** Per-item template HTML with {{field}} / {{url}} placeholders. Falls
   *  back to a basic `<li><a href="{{url}}">{{title}}</a></li>` when omitted. */
  item_template?: string;
  /** Wrapping element shape — defaults to `<ul class="tr-listing">`. */
  wrap_open?: string;
  wrap_close?: string;
  /** Empty-state HTML when no items exist. */
  empty_html?: string;
  /** Override the collection's sort_field / sort_dir for this listing. */
  sort_field?: string;
  sort_dir?: 'asc' | 'desc';
  /** "published" (default) | "all" — limit which items show up. */
  status_filter?: 'published' | 'all';
  /** Hard cap on items rendered. Default 500. */
  limit?: number;
}

const DEFAULT_ITEM_TEMPLATE = `<li><a href="{{url}}">{{title}}</a></li>`;
const DEFAULT_WRAP_OPEN = '<ul class="tr-listing">';
const DEFAULT_WRAP_CLOSE = '</ul>';
const DEFAULT_EMPTY = '<p class="tr-listing-empty">No items yet.</p>';

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

function fillTemplate(template: string, item: CollectionItem, url: string | null): string {
  // {{{field}}} raw substitution first, then {{field}} escaped. Plus the
  // special {{url}} that resolves through resolveItemPath.
  const data: Record<string, unknown> = { ...item, url: url ?? '#' };
  return template
    .replace(/\{\{\{([^{}]+)\}\}\}/g, (_m, name: string) => asString(data[name.trim()]))
    .replace(/\{\{([^{}]+)\}\}/g, (_m, name: string) => escapeHtml(asString(data[name.trim()])));
}

function buildMarkers(name: string): { start: string; end: string; startRe: RegExp; endRe: RegExp } {
  const start = `<!-- typeroll:listing:${name} -->`;
  const end = `<!-- /typeroll:listing:${name} -->`;
  return {
    start, end,
    startRe: new RegExp(`<!--\\s*typeroll:listing:${name.replace(/[-/]/g, '\\$&')}\\s*-->`),
    endRe: new RegExp(`<!--\\s*/typeroll:listing:${name.replace(/[-/]/g, '\\$&')}\\s*-->`),
  };
}

/**
 * Compare two field values, picking the right semantics based on the
 * field's declared type. Until 2026-05 this was string-only, which sorted
 * episode 9 above 23 (lex). Reported from autopilot.se /podd. Numeric and
 * date fields now compare correctly; everything else stays on
 * localeCompare for a stable Unicode-aware string sort.
 */
function compareByField(
  a: CollectionItem,
  b: CollectionItem,
  field: string,
  fieldType: string | undefined,
): number {
  const aRaw = (a as Record<string, unknown>)[field];
  const bRaw = (b as Record<string, unknown>)[field];

  if (fieldType === 'number') {
    const an = typeof aRaw === 'number' ? aRaw : Number(aRaw);
    const bn = typeof bRaw === 'number' ? bRaw : Number(bRaw);
    // Items missing the field (NaN) sort to the end consistently so a
    // partial dataset doesn't shuffle around.
    const aMissing = !Number.isFinite(an);
    const bMissing = !Number.isFinite(bn);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return an - bn;
  }

  if (fieldType === 'date' || fieldType === 'datetime') {
    // ISO 8601 dates DO sort correctly lexically, but only when both
    // values are well-formed. Coerce to timestamps to be robust to
    // mixed shapes (epoch numbers, sloppy strings, etc.); missing /
    // unparseable dates sort to the end.
    const at = aRaw == null ? NaN : new Date(aRaw as string | number).getTime();
    const bt = bRaw == null ? NaN : new Date(bRaw as string | number).getTime();
    const aMissing = !Number.isFinite(at);
    const bMissing = !Number.isFinite(bt);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return at - bt;
  }

  return asString(aRaw).localeCompare(asString(bRaw));
}

function sortItems(items: CollectionItem[], coll: CollectionDef, override?: { field?: string; dir?: 'asc' | 'desc' }): CollectionItem[] {
  const field = override?.field ?? coll.sort_field;
  const dir = override?.dir ?? coll.sort_dir ?? 'asc';
  if (!field) return items;
  const fieldType = coll.fields.find((f) => f.name === field)?.type;
  return [...items].sort((a, b) => {
    const cmp = compareByField(a, b, field, fieldType);
    return dir === 'desc' ? -cmp : cmp;
  });
}

export const POST: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const name = params.name;
  if (!name) return apiError('Missing collection name');

  const body = (await request.json().catch(() => null)) as RegenBody | null;
  if (!body || !body.page_id) return apiError('Body must include page_id');

  const coll = await vstore.collection(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if (!coll) return apiError(`Collection "${name}" not found`, 404);

  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, body.page_id);
  if (!page) return apiError(`Page "${body.page_id}" not found`, 404);

  const html = typeof page.html_content === 'string' ? page.html_content : '';
  const markers = buildMarkers(name);
  const startMatch = markers.startRe.exec(html);
  const endMatch = markers.endRe.exec(html);
  if (!startMatch || !endMatch || endMatch.index < startMatch.index) {
    return apiError(
      `Markers not found in page body. Add this pair where you want the listing to appear:\n` +
      `  ${markers.start}\n` +
      `  (the tool fills this in)\n` +
      `  ${markers.end}\n` +
      `Then call this endpoint again.`,
      400,
    );
  }

  // Render the items section.
  let items = await vstore.collectionItems(ctx.orgId, ctx.siteId, ctx.versionId, name);
  if ((body.status_filter ?? 'published') === 'published') {
    items = items.filter((i) => i.status === 'published');
  }
  items = sortItems(items, coll, { field: body.sort_field, dir: body.sort_dir });
  if (typeof body.limit === 'number' && body.limit > 0) {
    items = items.slice(0, Math.min(body.limit, 500));
  } else {
    items = items.slice(0, 500);
  }

  const template = body.item_template ?? DEFAULT_ITEM_TEMPLATE;
  const wrapOpen = body.wrap_open ?? DEFAULT_WRAP_OPEN;
  const wrapClose = body.wrap_close ?? DEFAULT_WRAP_CLOSE;

  let listingBody: string;
  if (items.length === 0) {
    listingBody = body.empty_html ?? DEFAULT_EMPTY;
  } else {
    const effective = effectiveRouteTemplate(coll);
    const lis = items.map((item) => {
      const url = resolveItemPath(effective, item);
      return fillTemplate(template, item, url);
    });
    listingBody = `${wrapOpen}\n${lis.join('\n')}\n${wrapClose}`;
  }

  const before = html.slice(0, startMatch.index + startMatch[0].length);
  const after = html.slice(endMatch.index);
  const newHtml = `${before}\n${listingBody}\n${after}`;

  await vstore.writePage(ctx.orgId, ctx.siteId, ctx.versionId, body.page_id, {
    html_content: newHtml,
    date_updated: new Date().toISOString(),
  });

  const fresh = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, body.page_id);
  return apiResponse(ctx, {
    page_id: body.page_id,
    collection: name,
    items_rendered: items.length,
    marker: { start: markers.start, end: markers.end },
    page: fresh,
  }, 200, { page_id: body.page_id, collection: name, items: items.length });
};
