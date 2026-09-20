import { responsiveBreakpointsError } from './breakpoints.js';
/** Validate before normalization or export. Paths identify the exact editable node. */
export function blockTreeError(value: unknown, root = 'blocks', requireIds = false): string | null {
  const ids = new Set<string>();
  const active = new Set<object>();
  function visit(value: unknown, path: string, depth: number): string | null {
    if (!Array.isArray(value)) return `${path} must be an array of blocks.`;
    if (depth > 50) return `${path} exceeds the maximum block nesting depth.`;
    for (let index = 0; index < value.length; index++) {
      const block = value[index], at = `${path}[${index}]`;
      if (!block || typeof block !== 'object' || Array.isArray(block)) return `${at} must be a block object.`;
      if (active.has(block)) return `${at} contains a circular block reference.`;
      if (typeof block.type !== 'string' || !block.type.trim()) return `${at}.type must be a non-empty string.`;
      if (block.data !== undefined && (!block.data || typeof block.data !== 'object' || Array.isArray(block.data))) return `${at}.data must be an object.`;
      if (requireIds) {
        if (typeof block.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(block.id)) return `${at}.id is missing. Save the block tree to assign IDs before publishing.`;
        if (ids.has(block.id)) return `${at}.id duplicates another block ID. Save the block tree before publishing.`;
        ids.add(block.id);
      }
      if (Object.hasOwn(block, 'responsive')) return `${at}.responsive is not a rendered field. Put breakpoint values in ${at}.data (for example data.cols={mobile:1,tablet:2,desktop:3}) or use the block responsive endpoint.`;
      for (const [suffix, data] of [['data', block.data], ['data.item_overrides', block.data?.item_overrides]] as const) {
        if (data && typeof data === 'object' && Object.hasOwn(data, 'responsive_breakpoints')) {
          const error = responsiveBreakpointsError(data.responsive_breakpoints);
          if (error) return `${at}.${suffix}.${error}`;
        }
      }
      active.add(block);
      if (block.children !== undefined) { const error = visit(block.children, `${at}.children`, depth + 1); if (error) return error; }
      if (block.slots !== undefined) {
        if (!Array.isArray(block.slots)) return `${at}.slots must be an array of block arrays.`;
        for (let slot = 0; slot < block.slots.length; slot++) {
          const error = visit(block.slots[slot], `${at}.slots[${slot}]`, depth + 1); if (error) return error;
        }
      }
      active.delete(block);
    }
    return null;
  }
  return visit(value, root, 0);
}
