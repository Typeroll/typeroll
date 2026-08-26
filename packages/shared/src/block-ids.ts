// Block-id normalisation for raw Block[] trees.
//
// Tools that mutate one block at a time (add_block & friends) generate ids
// as they go, but every surface that accepts a WHOLE tree (create_page with
// blocks, PATCH page/partial blocks, item_template_blocks, writeContainer)
// historically trusted the caller to supply them. Agents routinely hand-write
// trees without ids — and a missing id crashed the renderer (sanitizeCssId
// on undefined) with an opaque 500. This walker assigns missing ids at write
// time so every persisted block is addressable (update_block, move_block,
// responsive styling all key on id).
//
// Id format matches block-mutations' generator: `blk_` + 12 chars of UUID.

import type { Block } from './types.js';

function newBlockId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : // Extremely defensive fallback for exotic runtimes without
        // crypto.randomUUID (the id only needs uniqueness within one tree).
        `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `blk_${uuid.slice(0, 12)}`;
}

/**
 * Walks a Block[] tree (children + slots) and assigns a fresh id to every
 * block whose id is missing or not a non-empty string. Duplicate ids within
 * the same tree are also re-assigned (keeping the first occurrence) so two
 * copy-pasted siblings don't fight over responsive styles. Mutates in place
 * and returns the same array for call-site convenience.
 */
export function ensureBlockIds(blocks: Block[] | undefined | null): Block[] {
  if (!Array.isArray(blocks)) return [];
  const seen = new Set<string>();
  const walk = (list: Block[]): void => {
    for (const block of list) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.id !== 'string' || block.id.length === 0 || seen.has(block.id)) {
        block.id = newBlockId();
      }
      seen.add(block.id);
      if (Array.isArray(block.children)) walk(block.children);
      if (Array.isArray(block.slots)) {
        for (const slot of block.slots) {
          if (Array.isArray(slot)) walk(slot);
        }
      }
    }
  };
  walk(blocks);
  return blocks;
}
