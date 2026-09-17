import { blockTreeError } from '@typeroll/shared';

/** Validate raw API/editor trees before assigning IDs. Omitted fields are unchanged. */
export function blockTreeInputError(blocks: unknown, root = 'blocks'): string | null {
  return blocks === undefined ? null : blockTreeError(blocks, root);
}
