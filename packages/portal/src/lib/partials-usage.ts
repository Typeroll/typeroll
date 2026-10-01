// Reverse index: for each global block (free partial), what references it:
//
// - pages, via <x-include name="…" /> (HTML pages) or a core/global_block
//   block (block pages), in the saved page or its draft;
// - page templates, via a core/global_block block anywhere in the tree;
// - other partials: header, footer and other global blocks (nesting), via a
//   core/global_block block in the saved partial or its draft, or an
//   <x-include> in an HTML header/footer (the renderer expands those there).
//
// Read at request time, never stored — the source of truth is the documents
// themselves, and a stored index would inevitably drift on the first missed
// write. Cheap (~50ms for 300 pages).
//
// Only direct references are listed: a block used inside another global
// block lists that global block, whose own usage shows where it appears.
// Header and footer themselves are never the target of a reference: they're
// auto-injected on every page by the renderer, so "which pages use them" is
// trivially "all of them." Callers that care about that case should ask for
// the page list directly.

import { vstore } from './version-store';
import { listWorkingCopies } from './working-copy';
import { globalBlockRefs, type Block, type WorkingCopy } from '@typeroll/shared';
import { emptyBlockUsage, type BlockUsage, type BlockUsagePage } from './block-usage-summary';

export type { BlockUsage, BlockUsageGlobalBlock, BlockUsagePage, BlockUsageTemplate } from './block-usage-summary';
export { blockUsageCount, describeBlockUsage, emptyBlockUsage } from './block-usage-summary';

const INCLUDE_TAG_GLOBAL = /<x-include\s+name=(?:"([^"]+)"|'([^']+)')\s*(?:\/>|>\s*<\/x-include>)/gi;

/** Global block ids a draft's block tree references, keyed by `kind--target_id`. */
function draftRefs(workingCopies: WorkingCopy[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const wc of workingCopies) {
    if (Array.isArray(wc.fields?.blocks)) out.set(`${wc.kind}--${wc.target_id}`, globalBlockRefs(wc.fields.blocks as Block[]));
  }
  return out;
}

function draftHtml(workingCopies: WorkingCopy[], kind: string, id: string): string | undefined {
  const html = workingCopies.find(wc => wc.kind === kind && wc.target_id === id)?.fields?.html_content;
  return typeof html === 'string' ? html : undefined;
}

/**
 * One pass over pages, templates and partials; returns block id → usage.
 * Use this when you need usage for every block at once (the partials list
 * page, the AI's list_blocks_with_usage).
 */
export async function getAllBlockUsage(
  orgId: string,
  siteId: string,
  versionId: string,
): Promise<Map<string, BlockUsage>> {
  const ctx = { orgId, siteId, versionId };
  const [pages, templates, partials, workingCopies] = await Promise.all([
    vstore.pages(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    listWorkingCopies(ctx),
  ]);
  const drafts = draftRefs(workingCopies);
  const out = new Map<string, BlockUsage>();
  const entry = (id: string): BlockUsage => {
    let usage = out.get(id);
    if (!usage) out.set(id, usage = emptyBlockUsage());
    return usage;
  };

  for (const p of pages) {
    const ids = new Set([...globalBlockRefs(p.blocks), ...(drafts.get(`page--${p.id}`) ?? [])]);
    for (const html of [p.html_content, draftHtml(workingCopies, 'page', p.id)]) {
      for (const id of listBlocksUsedInHtml(typeof html === 'string' ? html : '')) ids.add(id);
    }
    const ref: BlockUsagePage = { page_id: p.id, title: p.title, slug: p.slug, status: p.status };
    for (const id of ids) entry(id).pages.push(ref);
  }

  for (const t of templates) {
    for (const id of globalBlockRefs(t.blocks)) {
      entry(id).templates.push({ template_id: t.id, label: t.label || t.name || t.id, status: t.status });
    }
  }

  for (const partial of partials) {
    const ids = new Set([...globalBlockRefs(partial.blocks), ...(drafts.get(`partial--${partial.id}`) ?? [])]);
    // <x-include> is expanded in header and footer HTML only.
    if (partial.kind === 'header' || partial.kind === 'footer') {
      for (const html of [partial.html_content, draftHtml(workingCopies, 'partial', partial.id)]) {
        for (const id of listBlocksUsedInHtml(html ?? '')) ids.add(id);
      }
    }
    ids.delete(partial.id);
    for (const id of ids) {
      entry(id).global_blocks.push({ partial_id: partial.id, name: partial.name, kind: partial.kind, status: partial.status });
    }
  }
  return out;
}

/** What references the given free block. Empty for unknown ids. */
export async function getBlockUsage(
  orgId: string,
  siteId: string,
  versionId: string,
  partialId: string,
): Promise<BlockUsage> {
  if (!partialId) return emptyBlockUsage();
  return (await getAllBlockUsage(orgId, siteId, versionId)).get(partialId) ?? emptyBlockUsage();
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
