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
import type { Page } from '@typeroll/shared';

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
  page_id: string;
  title: string;
  before: string;
  after: string;
  matches_on_page: number;
}

export interface ReplaceResult {
  dry_run: boolean;
  /** Pages whose working copy was written (always 0 when dry_run=true). */
  updated: number;
  /** Pages whose working copy was also COMMITTED (only when save=true). */
  saved: number;
  /** Total match count across every page scanned. */
  total_matches: number;
  /** Number of pages whose body contains at least one match. */
  pages_with_matches: number;
  /** Number of sample_diffs returned in this response (capped at 3). */
  sample_diffs_shown: number;
  /** Pages with matches that DIDN'T get a sample_diff because the cap
   *  was hit. = pages_with_matches - sample_diffs_shown. */
  additional_pages_with_matches: number;
  /**
   * @deprecated Will be removed in a future version. Was the count of
   * pages skipped during the scan (no body, no matches, or no change
   * after replace). Use pages_with_matches to know what the operation
   * actually touches. Kept temporarily for back-compat with callers
   * pinned to <0.6.0.
   */
  skipped: number;
  /** Up to 3 representative diffs. Always present (even on real runs) so the
   *  caller can show the user what changed. */
  sample_diffs: ReplaceDiff[];
}

export async function bulkReplaceText(
  orgId: string,
  siteId: string,
  versionId: string,
  opts: ReplaceOptions,
): Promise<ReplaceResult> {
  const { pattern, replacement, regex = false, pageIds, dryRun = false, save = false } = opts;
  const updatedBy = opts.updatedBy ?? 'bulk-replace';
  if (!pattern) throw new Error('pattern required');

  let re: RegExp;
  try {
    re = regex ? new RegExp(pattern, 'gi') : new RegExp(escapeRegexLiteral(pattern), 'g');
  } catch (e) {
    throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }

  const allPages = await vstore.pages(orgId, siteId, versionId);
  const restrictTo = pageIds ? new Set(pageIds) : null;
  const rawCandidates = restrictTo ? allPages.filter((p) => restrictTo.has(p.id)) : allPages;
  // Operate on the DRAFT view — a page with unsaved working-copy edits is
  // matched/replaced on what the user actually sees in the editor.
  const wcs = await listWorkingCopies({ orgId, siteId, versionId });
  const candidates = rawCandidates.map((p) =>
    overlayWorkingCopy(p, wcs.find((w) => w.kind === 'page' && w.target_id === p.id)),
  );

  const sampleDiffs: ReplaceDiff[] = [];
  let updated = 0;
  let saved = 0;
  let skipped = 0;
  let totalMatches = 0;
  let pagesWithMatches = 0;

  for (const p of candidates) {
    const html = typeof p.html_content === 'string' ? p.html_content : '';
    if (!html) { skipped++; continue; }
    // /g + /gi flags make re stateful; reset per page.
    re.lastIndex = 0;
    const matchCount = (html.match(re) ?? []).length;
    if (matchCount === 0) { skipped++; continue; }
    totalMatches += matchCount;
    pagesWithMatches++;
    re.lastIndex = 0;
    const next = html.replace(re, replacement);
    if (next === html) { skipped++; continue; }
    if (sampleDiffs.length < 3) {
      const firstIdx = html.search(re);
      const start = Math.max(0, firstIdx - 40);
      const beforeWindow = html.slice(start, Math.min(html.length, firstIdx + pattern.length + 80));
      const afterWindow = next.slice(start, Math.min(next.length, firstIdx + replacement.length + 80));
      sampleDiffs.push({
        page_id: p.id,
        title: p.title,
        before: beforeWindow,
        after: afterWindow,
        matches_on_page: matchCount,
      });
    }
    if (!dryRun) {
      // Buffer model: the replacement lands in the working copy; save=true
      // commits it through the shared canonical-write path.
      await mergeWorkingCopy(
        { orgId, siteId, versionId },
        { kind: 'page', id: p.id },
        { html_content: next },
        updatedBy,
      );
      updated++;
      if (save) {
        const commit = await commitWorkingCopy(
          { orgId, siteId, versionId },
          { kind: 'page', id: p.id },
          updatedBy,
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
    sample_diffs_shown: sampleDiffs.length,
    additional_pages_with_matches: Math.max(0, pagesWithMatches - sampleDiffs.length),
    sample_diffs: sampleDiffs,
  };
}
