// Response shapes for the single-block write routes (add, update, move,
// remove, duplicate, responsive).
//
// Every one of them answered with the container's whole block tree: 68 kB
// for one add_block on an article page, most of it unrelated to the write.
// `response: "summary"` answers with the changed block and where it sits
// instead. "tree" stays the HTTP default so existing callers see no change;
// MCP asks for "summary".
//
// The mode is read from the `response` query parameter or body key. MCP sends
// the query parameter, which an older Core ignores (it answers with the
// tree), where an unknown body key would be refused.

import type { Block } from '@typeroll/shared';
import { findBlock } from './block-mutations';

export const BLOCK_WRITE_RESPONSES = ['summary', 'tree'] as const;
export type BlockWriteResponse = (typeof BLOCK_WRITE_RESPONSES)[number];

/** The requested response shape, the body's `response` over the query's; "tree" when neither is set. */
export function blockWriteResponse(request: Request, body?: { response?: unknown } | null): BlockWriteResponse | { error: string } {
  const value = body?.response ?? new URL(request.url).searchParams.get('response') ?? 'tree';
  return (BLOCK_WRITE_RESPONSES as readonly unknown[]).includes(value)
    ? value as BlockWriteResponse
    : { error: `response must be "summary" or "tree", got ${JSON.stringify(value)}.` };
}

export interface BlockLocation {
  /** The containing block, or null at the container's top level. */
  parent_id: string | null;
  /** The parent's slot holding the block (slot containers), else null. */
  slot_index: number | null;
  /** 0-based index in that list (top level, children or slot). */
  position: number;
}

export function blockLocation(tree: Block[], blockId: string): BlockLocation | null {
  const found = findBlock(tree, blockId);
  if (!found) return null;
  return { parent_id: found.parent?.id ?? null, slot_index: found.parentSlotIndex, position: found.index };
}

/**
 * The compact answer for a write that left `blockId` in `tree`: the block
 * (with its own children and slots), where it sits, and whether the
 * container has unsaved changes.
 */
export function blockWriteSummary(
  tree: Block[],
  blockId: string,
  hasUnsavedChanges: boolean,
): { block: Block | null; has_unsaved_changes: boolean } & Partial<BlockLocation> {
  const found = findBlock(tree, blockId);
  return {
    block: found?.block ?? null,
    ...(found ? { parent_id: found.parent?.id ?? null, slot_index: found.parentSlotIndex, position: found.index } : {}),
    has_unsaved_changes: hasUnsavedChanges,
  };
}
