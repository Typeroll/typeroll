import {
  buildCoreBlockRegistry,
  type Block,
  type BlockTemplate,
  type BlockType,
  type Partial as PartialDoc,
  type PageTemplate,
  type Page,
  type WorkingCopy,
} from '@typeroll/shared';
import { vstore } from './version-store';
import { listWorkingCopies } from './working-copy';
import { listBlockTemplates } from './block-templates-store';

/**
 * Where a block type is used, across every surface that can hold one.
 *
 * Asking whether a block type is in use should give the same answer regardless
 * of which surface it lives on. Until 2026-09-22 this scanned pages only, so a
 * type used exclusively by a page template — which is how a content type's
 * default layout uses one — reported zero. A Moveria checklist was rendering
 * two such types at the moment the endpoint said nothing used them.
 *
 * A block type is also used where nothing names it directly:
 * - as a repeater's `item_block` (or an alias whose defaults set one);
 * - inside another site block type's composition, alias target or repeater,
 *   and then wherever that block type is placed (`via` names it);
 * - in drafts (working copies) of pages and global blocks, and in block
 *   templates.
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

/** Looks up a block type by id (core registry first, then the site's own). */
export type BlockTypeResolver = (id: string) => BlockType | undefined;

/**
 * Every block type id a tree references: block types, repeater `item_block`
 * values, and the `item_block` an alias (e.g. a gallery-like type) supplies
 * through its `expand_to` defaults.
 */
export function blockTypeRefs(blocks: readonly Block[] | undefined, resolve?: BlockTypeResolver, out = new Set<string>()): Set<string> {
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.type === 'string') out.add(block.type);
    const item = itemBlockOf(block, resolve);
    if (item) out.add(item);
    blockTypeRefs(block.children, resolve, out);
    for (const slot of block.slots ?? []) blockTypeRefs(slot, resolve, out);
  }
  return out;
}

/** The block type a repeater (or repeater alias) renders each item with. */
export function itemBlockOf(block: Block, resolve?: BlockTypeResolver): string | undefined {
  const own = block.data?.item_block;
  if (typeof own === 'string' && own) return own;
  const alias = resolve?.(block.type)?.expand_to?.defaults?.item_block;
  return typeof alias === 'string' && alias ? alias : undefined;
}

export type UsageSource = 'saved' | 'draft';

export interface BlockTypeUsage {
  pages: Array<{ page_id: string; title: string; slug: string; status: string; sources: UsageSource[]; via?: string[] }>;
  templates: Array<{ template_id: string; name?: string; via?: string[] }>;
  /** Header, footer and global blocks. */
  partials: Array<{ partial_id: string; kind?: string; name?: string; sources: UsageSource[]; via?: string[] }>;
  block_templates: Array<{ block_template_id: string; name: string; via?: string[] }>;
  /** Other site block types built from this one. */
  block_types: Array<{ type_id: string; label: string; via: Array<'composition' | 'expand_to' | 'item_block'> }>;
}

export function emptyBlockTypeUsage(): BlockTypeUsage {
  return { pages: [], templates: [], partials: [], block_templates: [], block_types: [] };
}

interface Ctx { orgId: string; siteId: string; versionId: string }

/** Core registry plus the site's block types, as one resolver. */
export function blockTypeResolver(siteTypes: readonly BlockType[]): BlockTypeResolver {
  const core = buildCoreBlockRegistry();
  const site = new Map(siteTypes.map(type => [type.id, type]));
  return (id: string) => core.get(id) ?? site.get(id);
}

/** How `type` uses `targetId` directly (composition, alias target, repeater item). */
function directDependency(type: BlockType, targetId: string, resolve: BlockTypeResolver): Array<'composition' | 'expand_to' | 'item_block'> {
  const via = new Set<'composition' | 'expand_to' | 'item_block'>();
  if (type.expand_to?.target === targetId) via.add('expand_to');
  if (type.expand_to?.defaults?.item_block === targetId) via.add('item_block');
  if (type.composition?.length) {
    if (blocksContainType(type.composition, targetId)) via.add('composition');
    else if (blockTypeRefs(type.composition, resolve).has(targetId)) via.add('item_block');
  }
  return [...via];
}

/**
 * The site block types that use `typeId`, directly or through other site
 * block types, mapped to the direct dependency reasons (empty for indirect).
 */
export function dependentBlockTypes(typeId: string, siteTypes: readonly BlockType[], resolve: BlockTypeResolver): Map<string, Array<'composition' | 'expand_to' | 'item_block'>> {
  const out = new Map<string, Array<'composition' | 'expand_to' | 'item_block'>>();
  let frontier = [typeId];
  const seen = new Set([typeId]);
  while (frontier.length) {
    const next: string[] = [];
    for (const type of siteTypes) {
      if (seen.has(type.id)) continue;
      const hits = frontier.filter(id => directDependency(type, id, resolve).length > 0);
      if (!hits.length) continue;
      seen.add(type.id);
      next.push(type.id);
      out.set(type.id, hits.includes(typeId) ? directDependency(type, typeId, resolve) : []);
    }
    frontier = next;
  }
  return out;
}

/** Ids among `refs` that make a tree use the target: itself, or a dependent type. */
function match(refs: Set<string>, typeId: string, dependents: Map<string, unknown>): { direct: boolean; via: string[] } | null {
  const direct = refs.has(typeId);
  const via = [...dependents.keys()].filter(id => refs.has(id)).sort();
  if (!direct && !via.length) return null;
  return { direct, via };
}

const withVia = (via: string[]) => (via.length ? { via } : {});

export async function getBlockTypeUsage(
  orgId: string,
  siteId: string,
  versionId: string,
  typeId: string,
): Promise<BlockTypeUsage> {
  const ctx: Ctx = { orgId, siteId, versionId };
  const [pages, templates, partials, siteTypes, workingCopies, blockTemplates] = await Promise.all([
    vstore.pages(orgId, siteId, versionId) as Promise<Page[]>,
    vstore.pageTemplates(orgId, siteId, versionId) as Promise<PageTemplate[]>,
    vstore.partials(orgId, siteId, versionId) as Promise<PartialDoc[]>,
    vstore.blockTypes(orgId, siteId, versionId),
    listWorkingCopies(ctx).catch(() => [] as WorkingCopy[]),
    listBlockTemplates(ctx).catch(() => [] as BlockTemplate[]),
  ]);
  const resolve = blockTypeResolver(siteTypes);
  const dependents = dependentBlockTypes(typeId, siteTypes, resolve);
  const usage = emptyBlockTypeUsage();
  const draftBlocks = (kind: string, id: string): Block[] | undefined => {
    const blocks = workingCopies.find(wc => wc.kind === kind && wc.target_id === id)?.fields?.blocks;
    return Array.isArray(blocks) ? blocks as Block[] : undefined;
  };
  const inDocAndDraft = (saved: Block[] | undefined, draft: Block[] | undefined) => {
    const savedHit = saved ? match(blockTypeRefs(saved, resolve), typeId, dependents) : null;
    const draftHit = draft ? match(blockTypeRefs(draft, resolve), typeId, dependents) : null;
    if (!savedHit && !draftHit) return null;
    const sources: UsageSource[] = [...(savedHit ? ['saved' as const] : []), ...(draftHit ? ['draft' as const] : [])];
    const via = [...new Set([...(savedHit?.via ?? []), ...(draftHit?.via ?? [])])].sort();
    return { sources, via };
  };

  for (const page of pages) {
    const hit = inDocAndDraft(page.content_mode === 'blocks' ? page.blocks : undefined, draftBlocks('page', page.id));
    if (hit) usage.pages.push({ page_id: page.id, title: page.title, slug: page.slug, status: page.status, sources: hit.sources, ...withVia(hit.via) });
  }
  for (const template of templates) {
    const hit = match(blockTypeRefs(template.blocks, resolve), typeId, dependents);
    if (hit) usage.templates.push({ template_id: template.id, name: (template as { name?: string }).name, ...withVia(hit.via) });
  }
  for (const partial of partials) {
    const hit = inDocAndDraft(partial.blocks, draftBlocks('partial', partial.id));
    if (hit) usage.partials.push({ partial_id: partial.id, kind: partial.kind, name: partial.name, sources: hit.sources, ...withVia(hit.via) });
  }
  for (const template of blockTemplates) {
    const hit = match(blockTypeRefs(template.blocks, resolve), typeId, dependents);
    if (hit) usage.block_templates.push({ block_template_id: template.id, name: template.name, ...withVia(hit.via) });
  }
  for (const [id, via] of dependents) {
    if (!via.length) continue; // indirect: listed under the type it uses directly
    const type = siteTypes.find(candidate => candidate.id === id);
    usage.block_types.push({ type_id: id, label: type?.label ?? id, via });
  }
  return usage;
}

/** Total across surfaces; what a deletion guard needs to refuse on. */
export function usageCount(usage: BlockTypeUsage): number {
  return usage.pages.length + usage.templates.length + usage.partials.length
    + usage.block_templates.length + usage.block_types.length;
}

/** "2 page(s), 1 template(s) …" for a refusal message. */
export function describeBlockTypeUsage(usage: BlockTypeUsage): string {
  const parts = [
    [usage.pages.length, 'page(s)'],
    [usage.templates.length, 'page template(s)'],
    [usage.partials.length, 'header, footer or global block(s)'],
    [usage.block_templates.length, 'block template(s)'],
    [usage.block_types.length, 'other block type(s)'],
  ].filter(([count]) => (count as number) > 0).map(([count, label]) => `${count} ${label}`);
  return parts.join(', ') || 'nothing';
}
