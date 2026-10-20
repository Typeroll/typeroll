// Write-time checks for single-block writes (add_block / update_block).
//
// Tree writes report through `blockTreeWarnings`; a one-block PATCH never
// sends a tree, so its warnings are assembled here: unknown style override
// keys and field values whose type the block's schema will not render.
//
// Unknown data keys are different: a single-block write names one block and
// its type, so a key no field of that type declares is rejected with where it
// probably belongs (`unknownFieldsBody`). Tree writes only warn about them
// (`unknown_field`), so a bulk write that is mostly right still lands.
import {
  blockDataTypeWarnings,
  blockTreeWarnings,
  buildCoreBlockRegistry,
  styleOverrideWarnings,
  unknownBlockDataFields,
  unknownBlockFields,
  type Block,
  type BlockTreeWarning,
  type BlockType,
  type UnknownFieldIssue,
} from '@typeroll/shared';
import { findBlock } from './block-mutations';
import { vstore } from './version-store';

type Ctx = { orgId: string; siteId: string; versionId: string };
type Registry = ReadonlyMap<string, BlockType>;

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

/** The written data without the keys a `null` removes. */
function setValues(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return data && Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
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
  registry?: Registry,
): Promise<BlockTreeWarning[]> {
  const warnings: BlockTreeWarning[] = styleOverrideWarnings(write.style_overrides, blockId);
  const data = setValues(write.data);
  const found = data && Object.keys(data).length ? findBlock(blocks, blockId) : null;
  if (data && found) {
    warnings.push(...blockDataTypeWarnings({ id: blockId, type: found.block.type, data }, registry ?? await siteBlockRegistry(ctx), blockId));
  }
  return warnings;
}

/** Unknown data keys in a block add_block inserts, its children and slots included. */
export function addBlockUnknownFields(block: unknown, registry: Registry): UnknownFieldIssue[] {
  return unknownBlockFields(block, registry, 'block');
}

/**
 * Unknown keys an update_block write sets. A `null` removes its key, so it
 * is never unknown: that is how a key stored by mistake is cleaned up. The
 * block's stored data resolves the type's context, e.g. a repeater's
 * `item_block` for the item_overrides suggestion.
 */
export function updateBlockUnknownFields(
  blocks: Block[],
  blockId: string,
  data: Record<string, unknown> | undefined,
  registry: Registry,
): UnknownFieldIssue[] {
  const written = setValues(data);
  if (!written || !Object.keys(written).length) return [];
  const found = findBlock(blocks, blockId);
  if (!found) return [];
  return unknownBlockDataFields(
    { id: blockId, type: found.block.type, data: { ...found.block.data, ...written } },
    registry,
    { path: 'data', keys: Object.keys(written) },
  );
}

/** The 400 body for a single-block write that set unknown keys. */
export function unknownFieldsBody(issues: UnknownFieldIssue[]): { error: string; code: 'unknown_field'; unknown_fields: UnknownFieldIssue[] } {
  const first = issues[0]!;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more unknown key${issues.length > 2 ? 's' : ''}, listed in unknown_fields)` : '';
  return {
    error: `${first.message}${more} Nothing was written.`,
    code: 'unknown_field',
    unknown_fields: issues,
  };
}

/**
 * Warnings for a write that replaced a block tree (page, partial, batch,
 * working copy). The site's block types are read only when the write
 * carried a tree.
 */
export async function treeWriteWarnings(
  ctx: Ctx,
  blocks: unknown,
  registry?: Registry,
): Promise<BlockTreeWarning[]> {
  if (blocks === undefined) return [];
  return blockTreeWarnings(blocks, 'blocks', registry ?? await siteBlockRegistry(ctx));
}
