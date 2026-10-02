/**
 * Composed block types: a block type whose output is a tree of existing
 * blocks (`BlockType.composition`) instead of a template.
 *
 * - `schema` declares the props people edit when they place the block.
 * - Inner blocks read props through exact bindings: a heading's text set to
 *   `{{props.title}}`. Bindings are resolved by the regular renderer, which
 *   puts the instance's props (with derived values, see block-fields.ts) in
 *   the render context.
 * - A `core/repeater` inside the tree loops over an array prop
 *   (`items: "{{props.items}}"`) and renders its children once per item,
 *   where `{{item.title}}` reads the item.
 *
 * The rendered blocks sit in one wrapper element carrying the block type's
 * name, so the block's own CSS, custom classes and visibility apply to it.
 */

import type { Block, BlockType, FieldDefinition } from './types.js';

/** Nesting limit for composed blocks that use other composed blocks. */
export const COMPOSITION_MAX_DEPTH = 4;

/** Schema defaults under the stored values. */
export function withFieldDefaults(fields: readonly FieldDefinition[] | undefined, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields ?? []) {
    if (field.default !== undefined) out[field.name] = field.default;
  }
  return { ...out, ...values };
}

/**
 * The composition with every block id prefixed by `prefix`, so instances on
 * one page (and items of one repeater) never share an id. Ids carry into
 * per-instance CSS selectors, which must stay unique.
 */
export function instanceTree(blocks: readonly Block[], prefix: string): Block[] {
  const visit = (block: Block): Block => ({
    ...block,
    id: `${prefix}__${block.id}`,
    data: block.data ?? {},
    ...(block.children ? { children: block.children.map(visit) } : {}),
    ...(block.slots ? { slots: block.slots.map(slot => slot.map(visit)) } : {}),
  });
  return blocks.map(visit);
}

/** Every block in a composition, depth first. */
export function walkComposition(blocks: readonly Block[] | undefined, visit: (block: Block) => void): void {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue;
    visit(block);
    walkComposition(block.children, visit);
    for (const slot of block.slots ?? []) walkComposition(slot, visit);
  }
}

/** True for a block type rendered from a composition rather than a template. */
export function isComposedBlockType(blockType: Pick<BlockType, 'composition'> | undefined): boolean {
  return Array.isArray(blockType?.composition) && blockType!.composition.length > 0;
}
