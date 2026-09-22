import type { Block, Partial as PartialDoc, PageTemplate, Page } from '@typeroll/shared';
import { vstore } from './version-store';

/**
 * Where a block type is used, across every surface that can hold one.
 *
 * Asking whether a block type is in use should give the same answer regardless
 * of which surface it lives on. Until 2026-09-22 this scanned pages only, so a
 * type used exclusively by a page template — which is how a content type's
 * default layout uses one — reported zero. A Moveria checklist was rendering
 * two such types at the moment the endpoint said nothing used them.
 */
export function blocksContainType(blocks: Block[] | undefined, typeId: string): boolean {
  if (!Array.isArray(blocks)) return false;
  for (const b of blocks) {
    if (b.type === typeId) return true;
    if (b.children && blocksContainType(b.children, typeId)) return true;
    if (Array.isArray(b.slots)) {
      for (const slot of b.slots) if (blocksContainType(slot, typeId)) return true;
    }
  }
  return false;
}

export interface BlockTypeUsage {
  pages: Array<{ page_id: string; title: string; slug: string; status: string }>;
  templates: Array<{ template_id: string; name?: string }>;
  partials: Array<{ partial_id: string; kind?: string }>;
}

export async function getBlockTypeUsage(
  orgId: string,
  siteId: string,
  versionId: string,
  typeId: string,
): Promise<BlockTypeUsage> {
  const [pages, templates, partials] = await Promise.all([
    vstore.pages(orgId, siteId, versionId) as Promise<Page[]>,
    vstore.pageTemplates(orgId, siteId, versionId) as Promise<PageTemplate[]>,
    vstore.partials(orgId, siteId, versionId) as Promise<PartialDoc[]>,
  ]);
  return {
    pages: pages
      .filter((p) => p.content_mode === 'blocks' && blocksContainType(p.blocks, typeId))
      .map((p) => ({ page_id: p.id, title: p.title, slug: p.slug, status: p.status })),
    templates: templates
      .filter((t) => blocksContainType(t.blocks, typeId))
      .map((t) => ({ template_id: t.id, name: (t as { name?: string }).name })),
    partials: partials
      .filter((p) => blocksContainType(p.blocks, typeId))
      .map((p) => ({ partial_id: p.id, kind: (p as { kind?: string }).kind })),
  };
}

/** Total across surfaces; what a deletion guard needs to refuse on. */
export function usageCount(usage: BlockTypeUsage): number {
  return usage.pages.length + usage.templates.length + usage.partials.length;
}
