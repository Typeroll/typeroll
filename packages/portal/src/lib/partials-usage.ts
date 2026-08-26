// Reverse index: for each global block (partial), which pages embed it via
// <x-include name="…" />. Read at request time, never stored — the source of
// truth is the page bodies themselves, and a stored index would inevitably
// drift on the first missed write. Cheap (~50ms for 300 pages).
//
// Header and footer are excluded from this index: they're auto-injected on
// every page by the renderer (not via <x-include>), so "which pages use them"
// is trivially "all of them." Callers that care about that case should ask
// for the page list directly.

import { vstore } from './version-store';
import type { Page } from '@typeroll/shared';

export interface BlockUsagePage {
  page_id: string;
  title: string;
  slug: string;
  status: Page['status'];
}

const INCLUDE_TAG_GLOBAL = /<x-include\s+name=(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>\s*<\/x-include>)/gi;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pages that include the given free block. Empty list for unknown ids or
 *  blocks that aren't free (header/footer don't show up as <x-include>). */
export async function getBlockUsage(
  orgId: string,
  siteId: string,
  versionId: string,
  partialId: string,
): Promise<BlockUsagePage[]> {
  if (!partialId) return [];
  const re = new RegExp(
    `<x-include\\s+name=(?:"${escapeRegex(partialId)}"|'${escapeRegex(partialId)}')\\s*(?:/>|>\\s*</x-include>)`,
    'i',
  );
  const pages = await vstore.pages(orgId, siteId, versionId);
  return pages
    .filter((p) => typeof p.html_content === 'string' && re.test(p.html_content))
    .map((p) => ({ page_id: p.id, title: p.title, slug: p.slug, status: p.status }));
}

/** One pass over all pages, returns block-id → embedding pages.
 *  Use this when you need usage counts for every block at once (e.g. the
 *  partials list page, the AI's list_blocks_with_usage). */
export async function getAllBlockUsage(
  orgId: string,
  siteId: string,
  versionId: string,
): Promise<Map<string, BlockUsagePage[]>> {
  const pages = await vstore.pages(orgId, siteId, versionId);
  const out = new Map<string, BlockUsagePage[]>();
  for (const p of pages) {
    const html = typeof p.html_content === 'string' ? p.html_content : '';
    if (!html || !html.includes('<x-include')) continue;
    // Per-page reset: stateful exec() reuses lastIndex across calls.
    INCLUDE_TAG_GLOBAL.lastIndex = 0;
    const seenOnPage = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = INCLUDE_TAG_GLOBAL.exec(html)) !== null) {
      const id = (m[1] ?? m[2] ?? '').trim();
      if (!id || seenOnPage.has(id)) continue;
      seenOnPage.add(id);
      const list = out.get(id) ?? [];
      list.push({ page_id: p.id, title: p.title, slug: p.slug, status: p.status });
      out.set(id, list);
    }
  }
  return out;
}

/** Parse a single page body and return the ids of every block it embeds. */
export function listBlocksUsedInHtml(html: string): string[] {
  if (!html || !html.includes('<x-include')) return [];
  INCLUDE_TAG_GLOBAL.lastIndex = 0;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_TAG_GLOBAL.exec(html)) !== null) {
    const id = (m[1] ?? m[2] ?? '').trim();
    if (id) ids.add(id);
  }
  return Array.from(ids);
}
