// Server-side primitives for bulk page operations. These power the REST API's
// /search and /bulk-replace endpoints (and the MCP server's search_pages /
// bulk_replace_text tools by extension). They were briefly exposed to the
// in-app chat in Phase 3 of the previous handoff and pulled back when the
// architectural decision was made: bulk operations are an
// agency / power-user concern, served through the public API, not the
// editor-facing chat.
//
// The functions go through vstore.writePage on writes so the SEO transform
// pass and per-resource revision snapshot still fire — these are part of the
// save contract, not optional plumbing. Bypassing them would silently break
// /revisions and Google rich-result eligibility on bulk-edited pages.

import { vstore } from './version-store';
import {
  commitWorkingCopy,
  listWorkingCopies,
  mergeWorkingCopy,
  overlayWorkingCopy,
} from './working-copy';
import { applyFieldAuthority } from './field-authority';
import type { Block, CollectionDef, CollectionItem, Page, Partial as PartialDoc } from '@typeroll/shared';

export interface SearchHit {
  page_id: string;
  title: string;
  slug: string;
  status: Page['status'];
  excerpt: string;
}

export interface FindOptions {
  /** Case-insensitive literal substring. Either this or `regex` must be set. */
  contains?: string;
  /** JS regex source (without slashes), case-insensitive. */
  regex?: string;
  /** Hard cap on returned matches. Defaults to 500. */
  limit?: number;
}

const DEFAULT_LIMIT = 500;

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findPagesMatching(
  orgId: string,
  siteId: string,
  versionId: string,
  opts: FindOptions,
): Promise<{ matches: SearchHit[]; total: number }> {
  const { contains, regex, limit = DEFAULT_LIMIT } = opts;
  if (!contains && !regex) {
    throw new Error('Provide either contains or regex.');
  }
  let firstIndex: (html: string) => number;
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(regex, 'i');
    } catch (e) {
      throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
    firstIndex = (html) => {
      const m = re.exec(html);
      return m ? m.index : -1;
    };
  } else {
    const needle = contains!.toLowerCase();
    firstIndex = (html) => html.toLowerCase().indexOf(needle);
  }

  const pages = await vstore.pages(orgId, siteId, versionId);
  const matches: SearchHit[] = [];
  for (const p of pages) {
    const html = typeof p.html_content === 'string' ? p.html_content : '';
    const idx = firstIndex(html);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 40);
    const end = Math.min(html.length, idx + 80);
    const excerpt = `${start > 0 ? '…' : ''}${html.slice(start, end).replace(/\s+/g, ' ').trim()}${end < html.length ? '…' : ''}`;
    matches.push({ page_id: p.id, title: p.title, slug: p.slug, status: p.status, excerpt });
    if (matches.length >= limit) break;
  }
  return { matches, total: matches.length };
}

export interface ReplaceOptions {
  /** Literal substring (default) or JS regex source if `regex` is true. */
  pattern: string;
  replacement: string;
  /** Treat `pattern` as a regex source. Always case-insensitive + global. */
  regex?: boolean;
  /** Restrict to these page ids. Omit to apply to every page that matches. */
  pageIds?: string[];
  /** Resource family to scan. Defaults to pages for backwards compatibility. */
  scope?: 'pages' | 'collection_items' | 'partials' | 'all';
  /** Restrict collection-item replacement to one collection. Omit to scan all
   *  collections when scope is collection_items/all. */
  collection?: string;
  /** Restrict items inside `collection`. Requires collection. */
  itemIds?: string[];
  /** Restrict partial replacement to these ids. */
  partialIds?: string[];
  /** When true, return sample diffs without writing. */
  dryRun?: boolean;
  /** Buffer model: replacements land in each page's WORKING COPY. Pass
   *  save=true to also commit every touched page (revision snapshot, SEO
   *  transform) — the usual choice for a user-approved sweep. */
  save?: boolean;
  /** Who performs the write — recorded on working copies + revisions. */
  updatedBy?: string;
}

export interface ReplaceDiff {
  target:
    | { kind: 'page'; id: string }
    | { kind: 'partial'; id: string }
    | { kind: 'item'; id: string; collection: string };
  /** Backwards-compatible shortcut, present for page matches only. */
  page_id?: string;
  title: string;
  field: string;
  before: string;
  after: string;
  matches_on_page: number;
}

export interface ReplaceResult {
  dry_run: boolean;
  /** Resources whose working copy was written (always 0 when dry_run=true). */
  updated: number;
  /** Resources whose working copy was also COMMITTED (only when save=true). */
  saved: number;
  /** Total match count across every selected resource. */
  total_matches: number;
  /** Number of pages whose body contains at least one match. */
  pages_with_matches: number;
  /** Number of matching resources across every selected family. */
  resources_with_matches: number;
  resource_counts: {
    pages: number;
    collection_items: number;
    partials: number;
  };
  conflicts: Array<{
    target: ReplaceDiff['target'];
    fields: string[];
  }>;
  /** Number of sample_diffs returned in this response (capped at 3). */
  sample_diffs_shown: number;
  /** Pages with matches that DIDN'T get a sample_diff because the cap
   *  was hit. = pages_with_matches - sample_diffs_shown. */
  additional_pages_with_matches: number;
  /** Matching resources of any kind omitted from sample_diffs. */
  additional_resources_with_matches: number;
  /**
   * @deprecated Will be removed in a future version. Was the count of
   * resources skipped during the scan (no body, no matches, or no change
   * after replace). Use pages_with_matches to know what the operation
   * actually touches. Kept temporarily for back-compat with callers
   * pinned to <0.6.0.
   */
  skipped: number;
  /** Up to 3 representative diffs. Always present (even on real runs) so the
   *  caller can show the user what changed. */
  sample_diffs: ReplaceDiff[];
}

interface ReplacementCandidate {
  target: ReplaceDiff['target'];
  title: string;
  fields: Record<string, unknown>;
  original: Page | PartialDoc | CollectionItem;
  collectionDef?: CollectionDef;
}

interface ReplacedField {
  value: unknown;
  matches: number;
  before: string;
  after: string;
}

function replaceUnknown(value: unknown, re: RegExp, replacement: string): ReplacedField {
  if (typeof value === 'string') {
    re.lastIndex = 0;
    const matches = (value.match(re) ?? []).length;
    if (matches === 0) return { value, matches: 0, before: '', after: '' };
    re.lastIndex = 0;
    const next = value.replace(re, replacement);
    const firstIdx = value.search(re);
    const start = Math.max(0, firstIdx - 40);
    return {
      value: next,
      matches,
      before: value.slice(start, Math.min(value.length, firstIdx + 120)),
      after: next.slice(start, Math.min(next.length, firstIdx + replacement.length + 80)),
    };
  }
  if (Array.isArray(value)) {
    let matches = 0;
    let before = '';
    let after = '';
    const next = value.map((entry) => {
      const result = replaceUnknown(entry, re, replacement);
      if (!before && result.matches > 0) ({ before, after } = result);
      matches += result.matches;
      return result.value;
    });
    return { value: matches > 0 ? next : value, matches, before, after };
  }
  if (value && typeof value === 'object') {
    let matches = 0;
    let before = '';
    let after = '';
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = replaceUnknown(entry, re, replacement);
      if (!before && result.matches > 0) ({ before, after } = result);
      matches += result.matches;
      next[key] = result.value;
    }
    return { value: matches > 0 ? next : value, matches, before, after };
  }
  return { value, matches: 0, before: '', after: '' };
}

/** Replace editorial block data only. Stable ids, block types and structural
 * metadata must never be changed by a text sweep. */
function replaceBlocks(blocks: Block[] | undefined, re: RegExp, replacement: string): ReplacedField {
  if (!blocks?.length) return { value: blocks, matches: 0, before: '', after: '' };
  let matches = 0;
  let before = '';
  let after = '';
  const walk = (block: Block): Block => {
    const data = replaceUnknown(block.data, re, replacement);
    if (!before && data.matches > 0) ({ before, after } = data);
    matches += data.matches;
    const children = block.children?.map(walk);
    const slots = block.slots?.map((slot) => slot.map(walk));
    return {
      ...block,
      data: data.value as Record<string, unknown>,
      ...(children ? { children } : {}),
      ...(slots ? { slots } : {}),
    };
  };
  const next = blocks.map(walk);
  return { value: matches > 0 ? next : blocks, matches, before, after };
}

export async function bulkReplaceText(
  orgId: string,
  siteId: string,
  versionId: string,
  opts: ReplaceOptions,
): Promise<ReplaceResult> {
  const {
    pattern, replacement, regex = false, pageIds, itemIds, partialIds,
    dryRun = false, save = false, scope = 'pages', collection,
  } = opts;
  const updatedBy = opts.updatedBy ?? 'bulk-replace';
  if (!pattern) throw new Error('pattern required');

  let re: RegExp;
  try {
    re = regex ? new RegExp(pattern, 'gi') : new RegExp(escapeRegexLiteral(pattern), 'g');
  } catch (e) {
    throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }

  const wcs = await listWorkingCopies({ orgId, siteId, versionId });
  const candidates: ReplacementCandidate[] = [];
  const includePages = scope === 'pages' || scope === 'all';
  const includeItems = scope === 'collection_items' || scope === 'all';
  const includePartials = scope === 'partials' || scope === 'all';
  if (itemIds && !collection) throw new Error('collection required when item_ids is set');
  if (pageIds && !includePages) throw new Error('page_ids requires scope pages or all');
  if ((collection || itemIds) && !includeItems) {
    throw new Error('collection and item_ids require scope collection_items or all');
  }
  if (partialIds && !includePartials) throw new Error('partial_ids requires scope partials or all');

  if (includePages) {
    const restrictTo = pageIds ? new Set(pageIds) : null;
    const pages = await vstore.pages(orgId, siteId, versionId);
    for (const base of restrictTo ? pages.filter((page) => restrictTo.has(page.id)) : pages) {
      const page = overlayWorkingCopy(
        base,
        wcs.find((wc) => wc.kind === 'page' && wc.target_id === base.id),
      );
      candidates.push({
        target: { kind: 'page', id: page.id },
        title: page.title,
        original: page,
        fields: page.content_mode === 'blocks'
          ? { blocks: page.blocks }
          : { html_content: page.html_content },
      });
    }
  }

  if (includePartials) {
    const restrictTo = partialIds ? new Set(partialIds) : null;
    const partials = await vstore.partials(orgId, siteId, versionId);
    for (const base of restrictTo ? partials.filter((partial) => restrictTo.has(partial.id)) : partials) {
      const partial = overlayWorkingCopy(
        base,
        wcs.find((wc) => wc.kind === 'partial' && wc.target_id === base.id),
      );
      candidates.push({
        target: { kind: 'partial', id: partial.id },
        title: partial.name,
        original: partial,
        fields: partial.content_mode === 'blocks'
          ? { blocks: partial.blocks }
          : { html_content: partial.html_content },
      });
    }
  }

  if (includeItems) {
    const definitions = collection
      ? [await vstore.collection(orgId, siteId, versionId, collection)].filter(Boolean) as CollectionDef[]
      : await vstore.collections(orgId, siteId, versionId);
    if (collection && definitions.length === 0) throw new Error(`Collection not found: ${collection}`);
    const restrictTo = itemIds ? new Set(itemIds) : null;
    for (const definition of definitions) {
      const items = await vstore.collectionItems(orgId, siteId, versionId, definition.name);
      for (const base of restrictTo ? items.filter((item) => restrictTo.has(item.id)) : items) {
        const item = overlayWorkingCopy(
          base,
          wcs.find((wc) => wc.kind === 'item' && wc.collection === definition.name && wc.target_id === base.id),
        );
        const fields = Object.fromEntries(
          definition.fields.map((field) => [field.name, item[field.name]]),
        );
        candidates.push({
          target: { kind: 'item', id: item.id, collection: definition.name },
          title: String(item[definition.slug_field ?? 'slug'] ?? item.id),
          original: item,
          collectionDef: definition,
          fields,
        });
      }
    }
  }

  const sampleDiffs: ReplaceDiff[] = [];
  let updated = 0;
  let saved = 0;
  let skipped = 0;
  let totalMatches = 0;
  let pagesWithMatches = 0;
  let resourcesWithMatches = 0;
  const resourceCounts = { pages: 0, collection_items: 0, partials: 0 };
  const conflicts: ReplaceResult['conflicts'] = [];

  for (const candidate of candidates) {
    const changes: Record<string, unknown> = {};
    let matchCount = 0;
    let firstDiff: { field: string; before: string; after: string } | undefined;
    for (const [field, value] of Object.entries(candidate.fields)) {
      const result = field === 'blocks'
        ? replaceBlocks(value as Block[] | undefined, re, replacement)
        : replaceUnknown(value, re, replacement);
      if (result.matches === 0) continue;
      changes[field] = result.value;
      matchCount += result.matches;
      firstDiff ??= { field, before: result.before, after: result.after };
    }
    if (matchCount === 0 || !firstDiff) { skipped++; continue; }

    if (candidate.target.kind === 'item' && candidate.collectionDef) {
      const authority = applyFieldAuthority({
        fields: candidate.collectionDef.fields,
        incoming: changes,
        existing: candidate.original as CollectionItem,
        actor: 'agent',
        actorId: updatedBy,
      });
      if (authority.rejected.length > 0) {
        conflicts.push({
          target: candidate.target,
          fields: authority.rejected.map((entry) => entry.field),
        });
        skipped++;
        continue;
      }
    }

    totalMatches += matchCount;
    resourcesWithMatches++;
    if (candidate.target.kind === 'page') {
      pagesWithMatches++;
      resourceCounts.pages++;
    } else if (candidate.target.kind === 'partial') {
      resourceCounts.partials++;
    } else {
      resourceCounts.collection_items++;
    }
    if (sampleDiffs.length < 3) {
      sampleDiffs.push({
        target: candidate.target,
        ...(candidate.target.kind === 'page' ? { page_id: candidate.target.id } : {}),
        title: candidate.title,
        field: firstDiff.field,
        before: firstDiff.before,
        after: firstDiff.after,
        matches_on_page: matchCount,
      });
    }
    if (!dryRun) {
      await mergeWorkingCopy(
        { orgId, siteId, versionId },
        candidate.target,
        changes,
        updatedBy,
      );
      updated++;
      if (save) {
        const commit = await commitWorkingCopy(
          { orgId, siteId, versionId },
          candidate.target,
          updatedBy,
          candidate.target.kind === 'item' ? 'agent' : undefined,
        );
        if (commit.committed) saved++;
      }
    }
  }

  return {
    dry_run: dryRun,
    updated,
    saved,
    skipped,
    total_matches: totalMatches,
    pages_with_matches: pagesWithMatches,
    resources_with_matches: resourcesWithMatches,
    resource_counts: resourceCounts,
    conflicts,
    sample_diffs_shown: sampleDiffs.length,
    additional_pages_with_matches: Math.max(
      0,
      pagesWithMatches - sampleDiffs.filter((diff) => diff.target.kind === 'page').length,
    ),
    additional_resources_with_matches: Math.max(0, resourcesWithMatches - sampleDiffs.length),
    sample_diffs: sampleDiffs,
  };
}
