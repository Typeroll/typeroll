/**
 * Two kinds of reusable blocks:
 *
 * - Global blocks are free partials (`Partial` with kind `free`). A page
 *   references one with a `core/global_block` block; it renders the global
 *   block's current published content in place, so an edit updates every
 *   page that uses it. HTML-mode pages keep `<x-include name="…" />`.
 * - Block templates are saved section starters. Inserting one copies its
 *   blocks, with fresh ids, into the page; later edits affect only that page.
 */

import { blockTreeError } from './block-tree-validation.js';
import type { Block, Partial as PartialDoc } from './types.js';

export const GLOBAL_BLOCK_TYPE_ID = 'core/global_block';
/** Nesting limit for global blocks that reference other global blocks. */
export const GLOBAL_BLOCK_MAX_DEPTH = 4;

export interface GlobalBlockContent {
  name?: string;
  blocks?: Block[];
  html?: string;
}

/** Resolves a global block id to its published content, or undefined. */
export type GlobalBlockSource = (id: string) => GlobalBlockContent | undefined;

/** A source over partial documents: published free partials only, like `<x-include>`. */
export function globalBlockSourceFromPartials(partials: readonly PartialDoc[]): GlobalBlockSource {
  const byId = new Map(partials.filter(p => p.kind === 'free' && p.status === 'published').map(p => [p.id, p]));
  return (id) => {
    const partial = byId.get(id);
    if (!partial) return undefined;
    return partial.content_mode === 'blocks'
      ? { name: partial.name, blocks: partial.blocks ?? [] }
      : { name: partial.name, html: partial.html_content ?? '' };
  };
}

function walk(blocks: readonly Block[] | undefined, visit: (block: Block) => void): void {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue;
    visit(block);
    walk(block.children, visit);
    for (const slot of block.slots ?? []) walk(slot, visit);
  }
}

/** Ids of the global blocks a tree references, in order of first use. */
export function globalBlockRefs(blocks: readonly Block[] | undefined): string[] {
  const ids: string[] = [];
  walk(blocks, block => {
    const id = block.type === GLOBAL_BLOCK_TYPE_ID ? block.data?.global_block_id : undefined;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}

/**
 * The tree plus the content of every global block it references
 * (transitively), for collecting the CSS and JS those blocks need.
 */
export function withGlobalBlockContent(blocks: Block[], source: GlobalBlockSource | undefined): Block[] {
  if (!source) return blocks;
  const out = [...blocks];
  const seen = new Set<string>();
  let pending = globalBlockRefs(blocks);
  for (let depth = 0; depth < GLOBAL_BLOCK_MAX_DEPTH && pending.length; depth++) {
    const next: string[] = [];
    for (const id of pending) {
      if (seen.has(id)) continue;
      seen.add(id);
      const content = source(id)?.blocks;
      if (!content?.length) continue;
      out.push(...content);
      next.push(...globalBlockRefs(content));
    }
    pending = next;
  }
  return out;
}

function newBlockId(): string {
  return `blk_${globalThis.crypto.randomUUID().slice(0, 12)}`;
}

/** A deep copy of a block tree with new ids, for inserting a template or detaching a global block. */
export function copyBlocksWithNewIds(blocks: readonly Block[]): Block[] {
  const copy = (block: Block): Block => {
    const next: Block = { ...JSON.parse(JSON.stringify(block)), id: newBlockId() };
    if (block.children) next.children = block.children.map(copy);
    if (block.slots) next.slots = block.slots.map(slot => slot.map(copy));
    return next;
  };
  return blocks.map(copy);
}

// ── Block templates ─────────────────────────────────────────────────────

export interface BlockTemplate {
  id: string;
  name: string;
  /** When to use it; shown to editors and agents. */
  description?: string;
  blocks: Block[];
  created_at: string;
  updated_at: string;
}

export const BLOCK_TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a block template body. Returns the cleaned fields or the first problem. */
export function validateBlockTemplateInput(input: unknown, partial = false): { value?: { name?: string; description?: string; blocks?: Block[] }; error?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Body must be an object' };
  const body = input as Record<string, unknown>;
  const unknown = Object.keys(body).filter(key => !['id', 'name', 'description', 'blocks'].includes(key));
  if (unknown.length) return { error: `Unknown fields: ${unknown.join(', ')}. Accepted: id, name, description, blocks.` };
  const value: { name?: string; description?: string; blocks?: Block[] } = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) return { error: 'name must be text up to 120 characters' };
    value.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 500) return { error: 'description must be text up to 500 characters' };
    value.description = body.description.trim();
  }
  if (body.blocks !== undefined || !partial) {
    if (!Array.isArray(body.blocks) || !body.blocks.length) return { error: 'blocks must be a non-empty block tree' };
    const treeError = blockTreeError(body.blocks);
    if (treeError) return { error: treeError };
    if (JSON.stringify(body.blocks).length > 500_000) return { error: 'A block template is limited to 500 KB' };
    value.blocks = body.blocks as Block[];
  }
  return { value };
}

/** A template id derived from its name, made unique among `taken`. */
export function blockTemplateId(name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'template';
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}
