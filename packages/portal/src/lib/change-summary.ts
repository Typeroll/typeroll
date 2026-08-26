// "What changed?" for a page's unsaved draft — the structured half of the
// review-changes surface (the visual half is the saved-vs-draft preview
// pair). Shared by the cookie route (editor overlay), the v1 route, and
// the MCP get_change_summary tool, so humans and agents read the same
// description of an edit.

import { diffBlocks, type Block, type BlockChange, type Page } from '@typeroll/shared';
import { vstore } from './version-store';
import { readWorkingCopy, type WcCtx } from './working-copy';

export interface PageChangeSummary {
  has_working_copy: boolean;
  /** Draft meta fields (title, seo_*, slug, …) that differ from the saved page. */
  meta_changed: string[];
  /** Structural + content diff of the block tree (empty for html-mode pages). */
  block_changes: BlockChange[];
}

export async function pageChangeSummary(
  ctx: WcCtx,
  pageId: string,
): Promise<PageChangeSummary | null> {
  const page = await vstore.page(ctx.orgId, ctx.siteId, ctx.versionId, pageId);
  if (!page) return null;
  const wc = await readWorkingCopy(ctx, { kind: 'page', id: pageId });
  if (!wc || !wc.fields || Object.keys(wc.fields).length === 0) {
    return { has_working_copy: false, meta_changed: [], block_changes: [] };
  }

  const fields = wc.fields as Record<string, unknown>;
  const meta_changed: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'blocks') continue;
    if (JSON.stringify(v) !== JSON.stringify((page as unknown as Record<string, unknown>)[k])) {
      meta_changed.push(k);
    }
  }

  const draftBlocks = fields.blocks as Block[] | undefined;
  const block_changes = draftBlocks
    ? diffBlocks((page as Page).blocks ?? [], draftBlocks)
    : [];

  return { has_working_copy: true, meta_changed: meta_changed.sort(), block_changes };
}
