import type { Block } from '@typeroll/shared';

/**
 * Whole-tree REST writes bypass the narrow block-mutation routes, so validate
 * fields that look supported but are not consumed by the renderer here too.
 * Responsive field values belong in block.data; the historical top-level
 * responsive shape is deliberately rejected instead of being stored inertly.
 */
export function blockTreeInputError(
  blocks: unknown,
  root = 'blocks',
): string | null {
  if (!Array.isArray(blocks)) return null;

  const visit = (entries: unknown[], path: string): string | null => {
    for (let index = 0; index < entries.length; index += 1) {
      const value = entries[index];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const block = value as Block;
      const blockPath = `${path}[${index}]`;
      if (Object.prototype.hasOwnProperty.call(block, 'responsive')) {
        return `${blockPath}.responsive is not a rendered field. Put breakpoint values in ${blockPath}.data (for example data.cols={mobile:1,tablet:2,desktop:3}) or use the block responsive endpoint.`;
      }
      const childError = visit(block.children ?? [], `${blockPath}.children`);
      if (childError) return childError;
      for (let slot = 0; slot < (block.slots?.length ?? 0); slot += 1) {
        const slotError = visit(block.slots?.[slot] ?? [], `${blockPath}.slots[${slot}]`);
        if (slotError) return slotError;
      }
    }
    return null;
  };

  return visit(blocks, root);
}
