// Reverse index for menus: which pages, page templates and partials show a
// menu through a `core/navigation_links` block with `source: "menu"`. The
// block's `menu` names the menu by id or by a location (`location:primary`);
// a location reference counts for the menu that fills that location now.
//
// Read at request time from the documents themselves (saved, and page and
// partial drafts), like partials-usage, so it cannot drift.

import type { Block, Menu, WorkingCopy } from '@typeroll/shared';
import { emptyBlockUsage, type BlockUsage } from './block-usage-summary';
import { vstore } from './version-store';
import { listWorkingCopies } from './working-copy';

export const NAVIGATION_LINKS_TYPE = 'core/navigation_links';

function walk(blocks: readonly Block[] | undefined, visit: (block: Block) => void): void {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue;
    visit(block);
    walk(block.children, visit);
    for (const slot of block.slots ?? []) walk(slot, visit);
  }
}

/** Menu references (`<id>` or `location:<name>`) in a block tree, in order of first use. */
export function menuRefs(blocks: readonly Block[] | undefined): string[] {
  const refs: string[] = [];
  walk(blocks, (block) => {
    if (block.type !== NAVIGATION_LINKS_TYPE || block.data?.source !== 'menu') return;
    const ref = typeof block.data?.menu === 'string' ? block.data.menu.trim() : '';
    if (ref && !refs.includes(ref)) refs.push(ref);
  });
  return refs;
}

/** Whether a reference names this menu, by id or by one of its locations. */
export function refersToMenu(ref: string, menu: Pick<Menu, 'id' | 'locations'>): boolean {
  if (ref.startsWith('location:')) return !!menu.locations?.includes(ref.slice('location:'.length));
  return ref === menu.id;
}

function draftBlocks(workingCopies: WorkingCopy[], kind: string, id: string): Block[] | undefined {
  const blocks = workingCopies.find((wc) => wc.kind === kind && wc.target_id === id)?.fields?.blocks;
  return Array.isArray(blocks) ? blocks as Block[] : undefined;
}

/** What shows the given menu. Empty for an unknown menu. */
export async function getMenuUsage(orgId: string, siteId: string, versionId: string, menuId: string): Promise<BlockUsage> {
  const menu = await vstore.menu(orgId, siteId, versionId, menuId);
  if (!menu) return emptyBlockUsage();
  const [pages, templates, partials, workingCopies] = await Promise.all([
    vstore.pages(orgId, siteId, versionId),
    vstore.pageTemplates(orgId, siteId, versionId),
    vstore.partials(orgId, siteId, versionId),
    listWorkingCopies({ orgId, siteId, versionId }),
  ]);
  const uses = (...trees: Array<Block[] | undefined>) => trees.some((tree) => menuRefs(tree).some((ref) => refersToMenu(ref, menu)));
  const usage = emptyBlockUsage();
  for (const page of pages) {
    if (uses(page.blocks, draftBlocks(workingCopies, 'page', page.id)))
      usage.pages.push({ page_id: page.id, title: page.title, slug: page.slug, status: page.status });
  }
  for (const template of templates) {
    if (uses(template.blocks)) usage.templates.push({ template_id: template.id, label: template.label || template.name || template.id, status: template.status });
  }
  for (const partial of partials) {
    if (uses(partial.blocks, draftBlocks(workingCopies, 'partial', partial.id)))
      usage.global_blocks.push({ partial_id: partial.id, name: partial.name, kind: partial.kind, status: partial.status });
  }
  return usage;
}
