// Write-time warnings for single-block writes (add_block / update_block).
//
// Tree writes report through `blockTreeWarnings`; a one-block PATCH never
// sends a tree, so its warnings are assembled here: unknown style override
// keys and field values whose type the block's schema will not render.
import { blockDataTypeWarnings, blockTreeWarnings, buildCoreBlockRegistry, styleOverrideWarnings, type Block, type BlockTreeWarning, type BlockType } from '@typeroll/shared';
import { findBlock } from './block-mutations';
import { vstore } from './version-store';

type Ctx = { orgId: string; siteId: string; versionId: string };

/** Core block types plus the site's own, which override core on a shared id. */
export async function siteBlockRegistry(ctx: Ctx): Promise<Map<string, BlockType>> {
  const registry = buildCoreBlockRegistry();
  try {
    for (const type of await vstore.blockTypes(ctx.orgId, ctx.siteId, ctx.versionId)) if (type?.id) registry.set(type.id, type);
  } catch {
    // Core types are still checked when the site library cannot be read.
  }
  return registry;
}

/**
 * Warnings for a write that set `data` and/or `style_overrides` on one block.
 * Only the written data keys are checked, so an older value elsewhere in the
 * block does not repeat on every unrelated write.
 */
export async function singleBlockWriteWarnings(
  ctx: Ctx,
  blocks: Block[],
  blockId: string,
  write: { data?: Record<string, unknown>; style_overrides?: unknown },
): Promise<BlockTreeWarning[]> {
  const warnings: BlockTreeWarning[] = styleOverrideWarnings(write.style_overrides, blockId);
  const data = write.data;
  const found = data && Object.keys(data).length ? findBlock(blocks, blockId) : null;
  if (data && found) {
    warnings.push(...blockDataTypeWarnings({ id: blockId, type: found.block.type, data }, await siteBlockRegistry(ctx), blockId));
  }
  return warnings;
}

/**
 * Warnings for a write that replaced a block tree (page, partial, batch).
 * The site's block types are read only when the write carried a tree.
 */
export async function treeWriteWarnings(
  ctx: Ctx,
  blocks: unknown,
  registry?: ReadonlyMap<string, BlockType>,
): Promise<BlockTreeWarning[]> {
  if (blocks === undefined) return [];
  return blockTreeWarnings(blocks, 'blocks', registry ?? await siteBlockRegistry(ctx));
}
